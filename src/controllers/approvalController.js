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
import { RiskRepository } from '../repositories/riskRepository.js';

export const listApprovalRequests = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { status } = req.query;

  const tenantDb = await getTenantConnection(orgId);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const filters = {};
  if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    filters.status = status;
  }
  let requests = await approvalRequestRepo.findByOrgId(org._id, filters);

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
  const { stepIndex, comments } = req.body;

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
    userAgent
  );

  res.json({
    success: true,
    data: approvalRequest
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
  const { stepIndex, comments } = req.body;

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
    userAgent
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

  const doc = approvalRequest.toObject ? approvalRequest.toObject() : { ...approvalRequest };

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

export const createApprovalMatrix = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { name, action_type, priority, description, positions } = req.body;

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

  const matrix = await approvalMatrixRepo.create({
    org_id: org._id,
    name: name || `Workflow for ${mappedType}`,
    description: description || '',
    priority: priority ?? 0,
    rules: [rule],
    is_default: false,
    is_active: true
  });

  res.status(201).json({
    success: true,
    data: matrix
  });
});

export const updateApprovalMatrix = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { matrixId } = req.params;
  const { name, description, priority, positions } = req.body;

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

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (priority !== undefined) updateData.priority = priority;

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
  const { riskPriority, comments } = req.body;

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
    userAgent
  );

  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(request.entity_id);
  if (risk) {
    const metadata = risk.metadata || {};
    metadata.department_head_priority = riskPriority;
    await riskRepo.update(request.entity_id, { metadata });
  }

  res.json({
    success: true,
    data: approvalRequest
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
