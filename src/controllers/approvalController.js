/**
 * Approval Controller
 * 
 * Handles HTTP requests for approval workflows
 */

import mongoose from 'mongoose';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { getTenantConnection } from '../db/connectionManager.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { PositionRepository } from '../repositories/positionRepository.js';
import { DepartmentRepository } from '../repositories/departmentRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { logInfo } from '../utils/logger.js';

// Helper function to convert workflow_category to display name
const getCategoryDisplayName = (category) => {
  const categoryNames = {
    risk_management: 'Risk Management',
    coi: 'Conflict of Interest',
    partner_vetting: 'Partner Vetting',
    funding_agreement: 'Funding Agreement',
    project_approval: 'Project Approval',
    expense_approval: 'Expense Approval',
    policy_approval: 'Policy Approval',
    hr_approval: 'HR Approval'
  };
  return categoryNames[category] || category;
};

export const listApprovalRequests = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { status } = req.query;

  const tenantDb = await getTenantConnection(orgId);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const { UserRepository } = await import('../repositories/userRepository.js');
  const { UserPositionRepository } = await import('../repositories/userPositionRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  // Check if user is admin (org owner)
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  const isAdmin = user?.is_org_owner;

  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const filters = {};
  if (status && ['pending', 'approved', 'rejected', 'cancelled', 'paused_for_coi'].includes(status)) {
    filters.status = status;
  }
  let requests = await approvalRequestRepo.findByOrgId(org._id, filters);

  // If user is NOT admin, filter to show only workflows user is associated with
  if (!isAdmin) {
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const userPositions = await userPositionRepo.findByUserId(userId, true);
    const posIdSet = new Set(userPositions.map(up => String(up.position_id?._id || up.position_id)));

    // Also check board_members (user may hold extra positions after authority transfer)
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const bmRepo = new BoardMemberRepository(tenantDb);
    const allBms = await bmRepo.findAllActiveByUserId(userId, org._id);
    if (allBms) {
      allBms.forEach(bm => {
        const pid = bm.position_id?._id?.toString?.() || bm.position_id?.toString?.();
        if (pid) posIdSet.add(pid);
      });
    }
    const userPositionIds = [...posIdSet];

    requests = requests.filter(request => {
      // ONLY include if user is an approver in any approval step
      // User must be involved in the approval chain
      
      // Include if user is an approver by user_id
      const isDirectApprover = request.approval_steps?.some(step => 
        String(step.approver_user_id?._id || step.approver_user_id) === String(userId)
      );
      if (isDirectApprover) return true;

      // Include if user's position is an approver in any approval step
      const isPositionApprover = request.approval_steps?.some(step => {
        const stepPositionId = String(step.approver_position_id?._id || step.approver_position_id);
        return userPositionIds.includes(stepPositionId);
      });
      if (isPositionApprover) return true;

      return false;
    });
  }

  // Enrich submitted_by with position (Admin for org owner)
  requests = requests.map((r) => {
    const doc = r.toObject ? r.toObject() : { ...r };
    if (doc.submitted_by) {
      doc.submitted_by = { ...doc.submitted_by };
      if (doc.submitted_by.is_org_owner) {
        doc.submitted_by.role = 'Admin';
        doc.submitted_by.position = 'Admin';
      }
    }
    return doc;
  });

  res.json({
    success: true,
    data: requests
  });
});

export const getPendingApprovals = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;

  const workflowService = new ApprovalWorkflowService(orgId);
  const approvals = await workflowService.getPendingApprovalsForUser(userId);

  res.json({
    success: true,
    data: approvals
  });
});

export const uploadAcknowledgementFiles = asyncHandler(async (req, res) => {
  const files = req.files;
  const orgId = req.body.org_id || req.orgId;

  if (!files || files.length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_FILES', message: 'No files uploaded' }
    });
  }

  // Import S3 upload utility
  const { uploadToS3 } = await import('../services/s3Service.js');
  
  const uploadedFiles = [];
  
  for (const file of files) {
    try {
      const result = await uploadToS3(file.buffer, file.originalname, file.mimetype, orgId, 'acknowledgements');
      uploadedFiles.push({
        name: file.originalname,
        size: file.size,
        type: file.mimetype,
        url: result.url,  // Changed from result.Location
        key: result.key   // Changed from result.Key
      });
    } catch (error) {
      console.error('Error uploading file to S3:', error);
      return res.status(500).json({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: 'Failed to upload files' }
      });
    }
  }

  res.json({
    success: true,
    data: { files: uploadedFiles }
  });
});

export const approveRequest = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;
  const { stepIndex, comments, acknowledgement } = req.body;

  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('user-agent');

  const workflowService = new ApprovalWorkflowService(orgId);
  const approvalRequest = await workflowService.processApproval(
    approvalRequestId,
    stepIndex,
    userId,
    'approved',
    comments,
    ipAddress,
    userAgent,
    acknowledgement
  );

  res.json({
    success: true,
    data: approvalRequest
  });
});

export const submitCoiRequest = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user?.userId || req.user?._id;
  const { approvalRequestId } = req.params;
  const { reason } = req.body;

  const workflowService = new ApprovalWorkflowService(orgId);
  const tenantDb = await workflowService.getTenantDb();
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const coiRepo = new CoiRequestRepository(tenantDb);

  const approvalRequest = await approvalRequestRepo.findById(approvalRequestId);
  if (!approvalRequest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Approval request not found' }
    });
  }

  if (approvalRequest.status === 'paused_for_coi') {
    return res.status(400).json({
      success: false,
      error: { code: 'REQUEST_PAUSED_FOR_COI', message: 'A COI review is already in progress' }
    });
  }

  if (approvalRequest.status !== 'pending') {
    return res.status(400).json({
      success: false,
      error: { code: 'REQUEST_NOT_PENDING', message: `Approval request is already ${approvalRequest.status}` }
    });
  }

  const steps = approvalRequest.approval_steps || [];
  const currentStepIndex = steps.findIndex((step, index) => {
    if (approvalRequest.approval_type === 'sequential') {
      return step.status === 'pending' && (index === 0 || steps[index - 1].status === 'approved');
    }
    return step.status === 'pending';
  });

  if (currentStepIndex < 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_PENDING_STEP', message: 'No pending approval step found to pause' }
    });
  }

  const orgObjectId = await workflowService._getOrgObjectId();
  const { matrix, rule } = await workflowService.findMatchingRule('coi', 0, orgObjectId);
  const approvers = await workflowService.resolveApprovers(rule, orgObjectId);

  logInfo('COI submit: resolved workflow and approvers', {
    approvalRequestId,
    orgId: String(orgObjectId),
    userId: String(userId),
    currentStepIndex,
    matrixId: String(matrix?._id || ''),
    ruleId: String(rule?._id || ''),
    approvalType: rule?.approval_type,
    approverCount: approvers.length,
    approverPositionIds: approvers.map((a) => String(a.position_id || ''))
  });

  const approvalSteps = approvers.map(approver => ({
    level: approver.level,
    approver_user_id: approver.user_id,
    approver_position_id: approver.position_id,
    approver_department_id: approver.department_id,
    status: 'pending'
  }));

  const coiRequest = await coiRepo.create({
    org_id: orgObjectId,
    parent_approval_request_id: approvalRequestId,
    parent_step_index: currentStepIndex,
    parent_entity_id: approvalRequest.entity_id,
    parent_entity_type: approvalRequest.entity_type,
    coi_reason: reason,
    approval_matrix_id: matrix._id,
    approval_type: rule.approval_type,
    status: 'pending',
    approval_steps: approvalSteps,
    submitted_by: userId
  });

  logInfo('COI submit: created COI request', {
    approvalRequestId,
    coiRequestId: String(coiRequest?._id || ''),
    status: coiRequest?.status,
    approvalSteps: coiRequest?.approval_steps?.length || 0
  });

  approvalRequest.status = 'paused_for_coi';
  approvalRequest.paused_step_index = currentStepIndex;
  approvalRequest.paused_at = new Date();
  approvalRequest.current_coi_request_id = coiRequest._id;
  approvalRequest.coi_request_ids = [...(approvalRequest.coi_request_ids || []), coiRequest._id];
  await approvalRequest.save();

  res.json({
    success: true,
    data: {
      approvalRequest,
      coiRequest
    }
  });
});

export const rejectRequest = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;
  const { stepIndex, comments, acknowledgement } = req.body;

  if (!comments || comments.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Rejection reason is required'
      }
    });
  }

  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('user-agent');

  const workflowService = new ApprovalWorkflowService(orgId);
  const approvalRequest = await workflowService.processApproval(
    approvalRequestId,
    stepIndex,
    userId,
    'rejected',
    comments,
    ipAddress,
    userAgent,
    acknowledgement || null
  );

  res.json({
    success: true,
    data: approvalRequest
  });
});

export const getApprovalRequestById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.user?._id;
  const { approvalRequestId } = req.params;

  const workflowService = new ApprovalWorkflowService(orgId);
  const tenantDb = await workflowService.getTenantDb();
  const { ApprovalRequestRepository } = await import('../repositories/approvalRequestRepository.js');
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const approvalRequest = await approvalRequestRepo.findById(approvalRequestId);

  if (!approvalRequest) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Approval request not found'
      }
    });
  }

  // Convert to plain object
  const doc = approvalRequest.toObject ? approvalRequest.toObject() : { ...approvalRequest };

  // Ensure acknowledgement_files from raw Mongo doc are present (bypass any Mongoose quirks)
  try {
    const raw = await approvalRequestRepo.ApprovalRequest.collection.findOne(
      { _id: approvalRequest._id },
      { projection: { approval_steps: 1 } }
    );
    if (raw?.approval_steps && doc.approval_steps) {
      raw.approval_steps.forEach((rawStep, idx) => {
        if (rawStep.acknowledgement_files) {
          doc.approval_steps[idx] = doc.approval_steps[idx] || {};
          doc.approval_steps[idx].acknowledgement_files = rawStep.acknowledgement_files;
        }
      });
    }
  } catch (e) {
    console.error('Failed to sync acknowledgement_files from raw doc:', e);
  }

  // Regenerate presigned URLs for acknowledgement files so they never expire
  try {
    const { getFileUrl } = await import('../services/s3Service.js');
    for (const step of (doc.approval_steps || [])) {
      if (step.acknowledgement_files?.length > 0) {
        for (const file of step.acknowledgement_files) {
          if (file.key) {
            try { file.url = await getFileUrl(file.key); } catch { /* keep existing url */ }
          }
        }
      }
    }
  } catch { /* s3 unavailable — keep stored urls */ }

  // Regenerate presigned URLs for rejection_review files
  try {
    const { getFileUrl: getUrl } = await import('../services/s3Service.js');
    for (const review of (doc.rejection_reviews || [])) {
      if (review.rejection_files?.length > 0) {
        for (const file of review.rejection_files) {
          if (file.key) {
            try { file.url = await getUrl(file.key); } catch { /* keep existing url */ }
          }
        }
      }
    }
  } catch { /* s3 unavailable */ }

  // Regenerate presigned URLs for escalation files (request_files + response files)
  try {
    const { getFileUrl: getUrl } = await import('../services/s3Service.js');
    for (const esc of (doc.escalations || [])) {
      for (const arr of [esc.request_files || [], esc.files || []]) {
        for (const file of arr) {
          if (file.key) {
            try { file.url = await getUrl(file.key); } catch { /* keep existing url */ }
          }
        }
      }
    }
  } catch { /* s3 unavailable */ }

  // Compute can_approve and current_step_index for the current user
  if (userId && doc.status === 'pending') {
    const steps = doc.approval_steps || [];
    const currentStepIndex = steps.findIndex((step, index) => {
      if (doc.approval_type === 'sequential') {
        return step.status === 'pending' &&
          (index === 0 || steps[index - 1].status === 'approved');
      }
      return step.status === 'pending';
    });
    const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : null;

    if (currentStep) {
      const userPositionIds = await workflowService._getUserPositionIds(userId);
      const canApprove = workflowService._canUserApproveStep(currentStep, userId, userPositionIds);
      doc.can_approve = canApprove;
      doc.current_step_index = currentStepIndex;
    } else {
      doc.can_approve = false;
      doc.current_step_index = -1;
    }
  } else {
    doc.can_approve = false;
    doc.current_step_index = -1;
  }

  // Enrich submitted_by with position for Approval Progress display
  if (doc.submitted_by) {
    doc.submitted_by = { ...doc.submitted_by };
    if (doc.submitted_by.is_org_owner) {
      doc.submitted_by.position = 'Admin';
    } else {
      const submitterId = doc.submitted_by._id || doc.submitted_by;
      try {
        const { UserPositionRepository } = await import('../repositories/userPositionRepository.js');
        const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
        const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
        const orgRepo = new OrganizationRepository(tenantDb);
        const org = await orgRepo.findOne();
        if (org) {
          const userPositionRepo = new UserPositionRepository(tenantDb);
          const positions = await userPositionRepo.findByUserId(submitterId);
          const title = positions?.[0]?.position_id?.title;
          if (title) {
            doc.submitted_by.position = title;
          } else {
            const boardMemberRepo = new BoardMemberRepository(tenantDb);
            const bms = await boardMemberRepo.BoardMember.find({ user_id: submitterId, org_id: org._id, is_active: true })
              .populate('position_id')
              .limit(1)
              .lean();
            const bmTitle = bms?.[0]?.position_id?.title || bms?.[0]?.custom_position_title || bms?.[0]?.position;
            if (bmTitle) doc.submitted_by.position = bmTitle;
          }
        }
      } catch (_) { /* keep existing */ }
    }
  }

  res.json({
    success: true,
    data: doc
  });
});

export const getApprovalMatrices = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  
  // Get the organization to get the actual ObjectId
  const org = await orgRepo.findOne();
  if (!org) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'ORG_NOT_FOUND',
        message: 'Organization not found'
      }
    });
  }
  
  // Get all active approval matrices, prefer default one first
  const defaultMatrix = await approvalMatrixRepo.findDefault(org._id);
  const allMatrices = await approvalMatrixRepo.findByOrgId(org._id);
  
  // Sort: default first, then by creation date
  const sortedMatrices = allMatrices.sort((a, b) => {
    if (a.is_default && !b.is_default) return -1;
    if (!a.is_default && b.is_default) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Populate position and department references
  const Position = tenantDb.models.Position || tenantDb.model('Position', (await import('../db/schemas/platform/positionSchema.js')).default);
  const Department = tenantDb.models.Department || tenantDb.model('Department', (await import('../db/schemas/platform/departmentSchema.js')).default);

  const matricesWithDetails = await Promise.all(
    sortedMatrices.map(async (matrix) => {
      const rulesWithDetails = await Promise.all(
        matrix.rules.map(async (rule) => {
          const approvalSteps = await Promise.all(
            rule.requires_approval_from.map(async (step) => {
              const stepDetails = { ...step.toObject() };
              
              if (step.position_id) {
                const position = await Position.findById(step.position_id);
                if (position) {
                  stepDetails.position = {
                    _id: position._id,
                    name: position.title, // Position schema uses 'title' field
                    level: position.level
                  };
                }
              }
              
              if (step.department_id) {
                const department = await Department.findById(step.department_id);
                if (department) {
                  stepDetails.department = {
                    _id: department._id,
                    name: department.name
                  };
                }
              }
              
              return stepDetails;
            })
          );
          
          return {
            ...rule.toObject(),
            requires_approval_from: approvalSteps
          };
        })
      );
      
      return {
        ...matrix.toObject(),
        rules: rulesWithDetails
      };
    })
  );

  res.json({
    success: true,
    data: matricesWithDetails
  });
});

const ACTION_TYPE_MAP = {
  risks: 'risk',
  risk: 'risk',
  expenses: 'expense',
  expense: 'expense',
  grants: 'grant',
  grant: 'grant',
  policies: 'policy',
  policy: 'policy',
  hr: 'hr'
};

const PRIORITY_LEVEL_MAP = { high: 3, medium: 2, low: 1 };

export const createApprovalMatrix = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { name, action_type, priority, priority_level, description, positions, workflow_category, workflow_type } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  // Validate workflow_category and workflow_type combinations
  if (workflow_category) {
    // Risk management must have workflow_type
    if (workflow_category === 'risk_management' && (!workflow_type || !['high', 'medium', 'low'].includes(workflow_type))) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Risk Management workflows must have workflow_type: high, medium, or low' }
      });
    }

    // Single-workflow categories cannot have workflow_type
    const singleWorkflowCategories = ['coi', 'partner_vetting', 'policy_approval', 'hr_approval'];
    if (singleWorkflowCategories.includes(workflow_category) && workflow_type) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `${getCategoryDisplayName(workflow_category)} workflows cannot have a workflow type` }
      });
    }

    // Financial workflows must have workflow_type
    const financialCategories = ['funding_agreement', 'expense_approval', 'project_approval'];
    if (financialCategories.includes(workflow_category) && (!workflow_type || !['petty_cash', 'low_cash', 'moderate_cash', 'high_cash'].includes(workflow_type))) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Financial workflows must have workflow_type: petty_cash, low_cash, moderate_cash, or high_cash' }
      });
    }

    // Check for single-workflow limit
    if (singleWorkflowCategories.includes(workflow_category)) {
      const existing = await approvalMatrixRepo.findByOrgId(org._id);
      const hasExisting = existing.some(m => 
        m.workflow_category === workflow_category && 
        m.is_active && 
        String(m._id) !== String(req.params.matrixId)
      );
      
      if (hasExisting) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Only one active ${getCategoryDisplayName(workflow_category)} workflow is allowed per organization` }
        });
      }
    }
  }

  const mappedType = ACTION_TYPE_MAP[action_type?.toLowerCase()] || action_type?.toLowerCase();

  const requiresApprovalFrom = await Promise.all(
    (positions || []).map(async (p, index) => {
      const posId = p.positionId || p.id;
      let positionId = null;
      let departmentId = null;
      if (posId) {
        const pos = await positionRepo.findById(posId);
        if (pos) {
          positionId = pos._id;
          departmentId = pos.department_id;
        }
      }
      return {
        approval_level: p.approvalLevel ?? index + 1,
        position_id: positionId,
        department_id: departmentId,
        user_id: null
      };
    })
  );

  const rule = {
    action_type: mappedType,
    min_amount: 0,
    requires_approval_from: requiresApprovalFrom,
    approval_type: 'sequential',
    is_active: true
  };

  const resolvedPriority = priority ?? (priority_level ? PRIORITY_LEVEL_MAP[priority_level] : 0);

  const matrixData = {
    org_id: org._id,
    name: name || `Workflow for ${mappedType}`,
    description: description || '',
    priority: resolvedPriority,
    priority_level: priority_level || null,
    rules: [rule],
    is_default: false,
    is_active: true
  };

  // Add optional fields
  if (workflow_category) matrixData.workflow_category = workflow_category;
  if (workflow_type) matrixData.workflow_type = workflow_type;

  const matrix = await approvalMatrixRepo.create(matrixData);

  res.status(201).json({
    success: true,
    data: matrix
  });
});

export const updateApprovalMatrix = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { matrixId } = req.params;
  const { name, description, priority, priority_level, positions, workflow_category, workflow_type } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  const matrix = await approvalMatrixRepo.findById(matrixId);
  if (!matrix || String(matrix.org_id) !== String(org._id)) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Approval matrix not found'
      }
    });
  }

  // Validate workflow_category and workflow_type if provided
  const categoryToValidate = workflow_category !== undefined ? workflow_category : matrix.workflow_category;
  const typeToValidate = workflow_type !== undefined ? workflow_type : matrix.workflow_type;

  if (categoryToValidate) {
    // Risk management must have workflow_type
    if (categoryToValidate === 'risk_management' && (!typeToValidate || !['high', 'medium', 'low'].includes(typeToValidate))) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Risk Management workflows must have workflow_type: high, medium, or low' }
      });
    }

    // Single-workflow categories cannot have workflow_type
    const singleWorkflowCategories = ['coi', 'partner_vetting', 'policy_approval', 'hr_approval'];
    if (singleWorkflowCategories.includes(categoryToValidate) && typeToValidate) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `${categoryToValidate} workflows cannot have a workflow_type` }
      });
    }

    // Financial workflows must have workflow_type
    const financialCategories = ['funding_agreement', 'expense_approval', 'project_approval'];
    if (financialCategories.includes(categoryToValidate) && (!typeToValidate || !['petty_cash', 'low_cash', 'moderate_cash', 'high_cash'].includes(typeToValidate))) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Financial workflows must have workflow_type: petty_cash, low_cash, moderate_cash, or high_cash' }
      });
    }
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (priority !== undefined) updateData.priority = priority;
  if (priority_level !== undefined) {
    updateData.priority_level = priority_level;
    if (priority === undefined) updateData.priority = PRIORITY_LEVEL_MAP[priority_level] ?? matrix.priority;
  }
  if (workflow_category !== undefined) updateData.workflow_category = workflow_category;
  if (workflow_type !== undefined) updateData.workflow_type = workflow_type;

  if (positions && Array.isArray(positions) && matrix.rules?.length > 0) {
    const allPositions = await positionRepo.findByOrgId(org._id);
    const requiresApprovalFrom = positions.map((p, index) => {
      const posId = p.positionId || p.id;
      const pos = allPositions.find((x) => x._id.toString() === posId);
      return {
        approval_level: p.approvalLevel ?? index + 1,
        position_id: pos?._id || null,
        department_id: pos?.department_id || null,
        user_id: null
      };
    });
    matrix.rules[0].requires_approval_from = requiresApprovalFrom;
    matrix.markModified('rules');
  }

  Object.assign(matrix, updateData);
  await matrix.save();

  res.json({
    success: true,
    data: matrix
  });
});

export const approveRiskWithPriority = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;
  const { likelihood, severity, comments, acknowledgement } = req.body;

  // Validate likelihood and severity
  if (!likelihood || !severity) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Likelihood and severity are required' }
    });
  }

  if (likelihood < 1 || likelihood > 5 || severity < 1 || severity > 5) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Likelihood and severity must be between 1 and 5' }
    });
  }

  // Calculate risk score
  const riskScore = likelihood * severity;
  
  // Auto-calculate priority based on risk matrix
  let riskPriority;
  if (riskScore >= 1 && riskScore <= 5) {
    riskPriority = 'low';
  } else if (riskScore >= 6 && riskScore <= 12) {
    riskPriority = 'moderate';
  } else if (riskScore >= 13 && riskScore <= 25) {
    riskPriority = 'high';
  }

  const tenantDb = await getTenantConnection(orgId);
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const request = await approvalRequestRepo.findById(approvalRequestId);

  if (!request) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Approval request not found' }
    });
  }
  if (request.entity_type !== 'risk') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TYPE', message: 'This endpoint is for risk approvals only' }
    });
  }

  const steps = request.approval_steps || [];
  const deptHeadStepIndex = steps.findIndex((s) => s.status === 'pending' && s.is_department_head);
  if (deptHeadStepIndex < 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_PENDING_STEP', message: 'No pending department head approval step found' }
    });
  }

  const ipAddress = req.ip || req.connection?.remoteAddress;
  const userAgent = req.get('user-agent');

  const workflowService = new ApprovalWorkflowService(orgId);
  const approvalRequest = await workflowService.processApproval(
    approvalRequestId,
    deptHeadStepIndex,
    userId,
    'approved',
    comments || '',
    ipAddress,
    userAgent,
    acknowledgement
  );

  // Update risk with likelihood, severity, and calculated priority
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(request.entity_id);
  if (risk) {
    await riskRepo.update(request.entity_id, {
      likelihood,
      consequence: severity,
      inherent_risk_score: riskScore,
      inherent_risk_level: riskPriority,
      'metadata.department_head_priority': riskPriority,
      'metadata.department_head_likelihood': likelihood,
      'metadata.department_head_severity': severity,
      'metadata.department_head_risk_score': riskScore,
      'metadata.risk_assessment_date': new Date()
    });
  }

  res.json({
    success: true,
    data: approvalRequest,
    riskAssessment: {
      likelihood,
      severity,
      riskScore,
      calculatedPriority: riskPriority
    }
  });
});

export const updateWorkflowPositions = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { actionType } = req.params;
  const { positions } = req.body;

  const mappedType = ACTION_TYPE_MAP[actionType.toLowerCase()] || actionType.toLowerCase();

  const tenantDb = await getTenantConnection(orgId);
  const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);
  const departmentRepo = new DepartmentRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  const allMatrices = await approvalMatrixRepo.findByOrgId(org._id);
  let matrix = null;
  let ruleIndex = -1;
  for (const m of allMatrices) {
    if (!m.rules || !Array.isArray(m.rules)) continue;
    const idx = m.rules.findIndex(
      (r) => r && (r.action_type === mappedType || r.action_type === actionType)
    );
    if (idx >= 0) {
      matrix = m;
      ruleIndex = idx;
      break;
    }
  }

  if (!matrix || ruleIndex < 0) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'WORKFLOW_NOT_FOUND',
        message: `No approval workflow found for action type: ${actionType}`
      }
    });
  }

  const allPositions = await positionRepo.findByOrgId(org._id);
  const allDepartments = await departmentRepo.findByOrgId(org._id);

  const requiresApprovalFrom = await Promise.all(
    (positions || []).map(async (p, index) => {
      const posId = p.positionId || p.id;
      let positionId = null;
      let departmentId = null;

      if (posId && posId.length === 24) {
        try {
          const pos = allPositions.find((x) => x._id.toString() === posId);
          if (pos) {
            positionId = pos._id;
            departmentId = pos.department_id;
          }
        } catch (_) {}
      } else {
        const pos = allPositions.find(
          (x) =>
            x.title === posId ||
            x.title?.toLowerCase() === String(posId).toLowerCase() ||
            x._id.toString() === posId
        );
        if (pos) {
          positionId = pos._id;
          departmentId = pos.department_id;
        }
      }

      return {
        approval_level: p.approvalLevel || index + 1,
        position_id: positionId,
        department_id: departmentId,
        user_id: null
      };
    })
  );

  const rule = matrix.rules[ruleIndex];
  rule.requires_approval_from = requiresApprovalFrom;
  matrix.markModified('rules');
  await matrix.save();

  res.json({
    success: true,
    message: 'Workflow positions updated',
    data: { matrixId: matrix._id, actionType: mappedType }
  });
});

// Rejection Workflow Endpoints

export const forwardRejection = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;
  const { forwardToUserId, rejectionComments, stepIndex, acknowledgement } = req.body;

  if (!rejectionComments || rejectionComments.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Rejection reason is required'
      }
    });
  }

  if (!forwardToUserId) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Forward to user is required'
      }
    });
  }

  const workflowService = new ApprovalWorkflowService(orgId);
  const result = await workflowService.forwardRejectionForReview(
    approvalRequestId,
    stepIndex,
    userId,
    forwardToUserId,
    rejectionComments,
    acknowledgement || null
  );

  res.json({
    success: true,
    data: result
  });
});

export const reviewRejection = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;
  const { reviewAction, reviewComments } = req.body;

  if (!reviewAction || !['accept_rejection', 'reject_rejection'].includes(reviewAction)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Valid review action is required (accept_rejection or reject_rejection)'
      }
    });
  }

  if (!reviewComments || reviewComments.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Review comments are required'
      }
    });
  }

  const workflowService = new ApprovalWorkflowService(orgId);
  const result = await workflowService.processRejectionReview(
    approvalRequestId,
    userId,
    reviewAction,
    reviewComments
  );

  res.json({
    success: true,
    data: result
  });
});

/**
 * Escalate a step to another user for opinion (comments/files)
 */
export const escalateForOpinion = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;
  const { stepIndex, escalateToUserId, comments, files } = req.body;

  const workflowService = new ApprovalWorkflowService(orgId);
  const result = await workflowService.escalateForOpinion(
    approvalRequestId,
    stepIndex,
    userId,
    escalateToUserId,
    comments,
    files || []
  );

  res.json({
    success: true,
    data: result
  });
});

/**
 * Respond to an escalation request (add opinion and optional files)
 */
export const respondToEscalation = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId, escalationId } = req.params;
  const { comments, files } = req.body;

  const workflowService = new ApprovalWorkflowService(orgId);
  const result = await workflowService.respondToEscalation(
    approvalRequestId,
    escalationId,
    userId,
    comments,
    files || []
  );

  res.json({
    success: true,
    data: result
  });
});

export const resubmitApproval = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { approvalRequestId } = req.params;

  const workflowService = new ApprovalWorkflowService(orgId);
  const result = await workflowService.resubmitForApproval(approvalRequestId, userId);

  res.json({
    success: true,
    data: result
  });
});

export const getPendingRejectionReviews = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;

  const tenantDb = await getTenantConnection(orgId);
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const reviews = await approvalRequestRepo.findPendingRejectionReviews(userId);

  res.json({
    success: true,
    data: reviews
  });
});

export const getWorkflowParticipants = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { approvalRequestId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const participants = await approvalRequestRepo.getApprovalWorkflowParticipants(approvalRequestId);

  res.json({
    success: true,
    data: participants
  });
});

/**
 * Download Approval Workflow PDF
 * GET /platform/approvals/:approvalRequestId/download-pdf
 */
export const downloadApprovalPDF = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { approvalRequestId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  const logoUrl = org?.logo_url || process.env.LOGO || '';

  // Fetch approval request with full population
  const ApprovalRequest = tenantDb.models.ApprovalRequest;
  const approvalRequest = await ApprovalRequest.findById(approvalRequestId)
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
    .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
    .lean();

  if (!approvalRequest) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Approval request not found' } });
  }

  // Fetch related entity
  let expense = null;
  let risk = null;
  const entityId = approvalRequest.entity_id?.toString();

  if (entityId) {
    if (approvalRequest.entity_type === 'expense') {
      const expenseSchema = (await import('../db/schemas/platform/expenseSchema.js')).default;
      const Expense = tenantDb.models.Expense || tenantDb.model('Expense', expenseSchema);
      expense = await Expense.findById(entityId).lean();
    } else if (approvalRequest.entity_type === 'risk') {
      const riskRepo = new RiskRepository(tenantDb);
      risk = await riskRepo.findById(entityId);
    }
  }

  const { generateApprovalPDF } = await import('../services/approvalPdfService.js');
  const pdfBuffer = await generateApprovalPDF(approvalRequest, expense, risk, logoUrl);

  const fileName = `approval_${approvalRequest.request_type || 'request'}_${approvalRequestId}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});
