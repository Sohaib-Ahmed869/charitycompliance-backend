/**
 * COI Controller
 * 
 * Handles HTTP requests for COI workflows
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { getTenantConnection } from '../db/connectionManager.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { CoiWorkflowService } from '../services/coiWorkflowService.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';

export const listCoiRequests = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { status, source } = req.query;

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

  const coiRepo = new CoiRequestRepository(tenantDb);
  const filters = {};
  
  if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    filters.status = status;
  }
  
  // Filter by submission source: 'internal', 'external', or 'all' (default)
  if (source && ['internal', 'external'].includes(source)) {
    filters.submission_source = source;
  }
  
  let requests = await coiRepo.findByOrgId(org._id, filters);

  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  const isOrgOwner = user?.is_org_owner;

  if (!isOrgOwner) {
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const userPositions = await userPositionRepo.findByUserId(userId, true);
    const posIdSet = new Set(userPositions.map((up) => String(up.position_id?._id || up.position_id)));

    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const bmRepo = new BoardMemberRepository(tenantDb);
    const allBms = await bmRepo.findAllActiveByUserId(userId, org._id);
    if (allBms) {
      allBms.forEach((bm) => {
        const pid = bm.position_id?._id?.toString?.() || bm.position_id?.toString?.();
        if (pid) posIdSet.add(pid);
      });
    }
    const userPositionIds = [...posIdSet];

    requests = requests.filter((request) => {
      const doc = request.toObject ? request.toObject() : { ...request };

      const submitterId = doc.submitted_by?._id || doc.submitted_by;
      if (submitterId && String(submitterId) === String(userId)) return true;

      const isDirectApprover = doc.approval_steps?.some((step) =>
        String(step.approver_user_id?._id || step.approver_user_id) === String(userId)
      );
      if (isDirectApprover) return true;

      const isPositionApprover = doc.approval_steps?.some((step) => {
        const stepPositionId = String(step.approver_position_id?._id || step.approver_position_id);
        return stepPositionId && userPositionIds.includes(stepPositionId);
      });
      return !!isPositionApprover;
    });
  }

  // Enrich data for display
  requests = requests.map((r) => {
    const doc = r.toObject ? r.toObject() : { ...r };
    
    // For internal requests, show the submitter
    if (doc.submitted_by) {
      doc.submitted_by = { ...doc.submitted_by };
      if (doc.submitted_by.is_org_owner) {
        doc.submitted_by.role = 'Admin';
        doc.submitted_by.position = 'Admin';
      }
    }
    
    // For external requests, show external submitter info
    if (doc.is_external && doc.external_submitter) {
      doc.submitted_by_name = doc.external_submitter.name;
      doc.submitted_by_email = doc.external_submitter.email;
      doc.is_external_submission = true;
    }
    
    return doc;
  });

  res.json({
    success: true,
    data: requests
  });
});

export const getPendingCoiRequests = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;

  const workflowService = new CoiWorkflowService(orgId);
  const requests = await workflowService.getPendingCoiForUser(userId);

  res.json({
    success: true,
    data: requests
  });
});

// DEBUG: Get all COI requests with details
export const debugGetAllCoi = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  
  const tenantDb = await getTenantConnection(orgId);
  const coiRepo = new CoiRequestRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  const allCoi = await coiRepo.findByOrgId(org._id);
  
  const workflowService = new CoiWorkflowService(orgId);
  const userPositionIds = await workflowService._getUserPositionIds(userId);
  
  res.json({
    success: true,
    debug: {
      currentUserId: userId,
      userPositionIds: userPositionIds.map(p => p?.toString?.() || p),
      totalCoiRequests: allCoi.length,
      requests: allCoi.map(coi => ({
        _id: coi._id,
        status: coi.status,
        parent_approval_request_id: coi.parent_approval_request_id,
        approval_steps: coi.approval_steps?.map(step => ({
          level: step.level,
          status: step.status,
          approver_user_id: step.approver_user_id,
          approver_position_id: step.approver_position_id?.toString?.() || step.approver_position_id,
          can_user_approve: workflowService._canUserApproveStep(step, userId, userPositionIds)
        }))
      }))
    }
  });
});

export const getCoiRequestById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { coiRequestId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const coiRepo = new CoiRequestRepository(tenantDb);
  const request = await coiRepo.findById(coiRequestId);

  if (!request) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'COI request not found' }
    });
  }

  res.json({
    success: true,
    data: request
  });
});

export const approveCoiRequest = asyncHandler(async (req, res) => {
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
  const { coiRequestId } = req.params;
  const { stepIndex, comments } = req.body;
  const ipAddress = req.ip || req.connection?.remoteAddress;
  const userAgent = req.get('user-agent');

  const workflowService = new CoiWorkflowService(orgId);
  const coiRequest = await workflowService.processCoiApproval(
    coiRequestId,
    stepIndex,
    userId,
    'approved',
    comments || '',
    ipAddress,
    userAgent
  );

  res.json({
    success: true,
    data: coiRequest
  });
});

export const rejectCoiRequest = asyncHandler(async (req, res) => {
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
  const { coiRequestId } = req.params;
  const { stepIndex, comments } = req.body;
  const ipAddress = req.ip || req.connection?.remoteAddress;
  const userAgent = req.get('user-agent');

  const workflowService = new CoiWorkflowService(orgId);
  const coiRequest = await workflowService.processCoiApproval(
    coiRequestId,
    stepIndex,
    userId,
    'rejected',
    comments || '',
    ipAddress,
    userAgent
  );

  res.json({
    success: true,
    data: coiRequest
  });
});

export const getParentApprovalForCoi = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { coiRequestId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const coiRepo = new CoiRequestRepository(tenantDb);
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

  const coiRequest = await coiRepo.findById(coiRequestId);
  if (!coiRequest) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'COI request not found' }
    });
  }

  const parent = await approvalRequestRepo.findById(coiRequest.parent_approval_request_id);

  res.json({
    success: true,
    data: parent
  });
});

// PUBLIC ENDPOINT: Submit external COI request
export const submitExternalCoi = asyncHandler(async (req, res) => {
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

  const { orgId } = req.params;
  const { external_submitter, coi_reason, conflict_person_name, conflict_person_details } = req.body;

  // Get organization from platform DB to validate it exists
  const { getTenantConnection: getTenantDb } = await import('../db/connectionManager.js');
  
  try {
    const tenantDb = await getTenantDb(orgId);
    const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();

    if (!org) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
      });
    }

    // Get COI workflow matrix and resolve approvers
    const { ApprovalMatrixRepository } = await import('../repositories/approvalMatrixRepository.js');
    const matrixRepo = new ApprovalMatrixRepository(tenantDb);
    const matrices = await matrixRepo.findByOrgId(org._id);
    
    // Find matrix with COI rules
    const coiMatrix = matrices?.find(matrix => 
      matrix.rules?.some(rule => rule.action_type === 'coi' && rule.is_active)
    );
    
    if (!coiMatrix) {
      return res.status(400).json({
        success: false,
        error: { 
          code: 'NO_COI_MATRIX', 
          message: 'COI approval workflow not configured. Please configure COI workflow in settings.' 
        }
      });
    }
    
    // Get the COI rule
    const coiRule = coiMatrix.rules.find(rule => rule.action_type === 'coi' && rule.is_active);
    if (!coiRule) {
      return res.status(400).json({
        success: false,
        error: { 
          code: 'NO_COI_RULE', 
          message: 'No active COI rule found in approval matrix.' 
        }
      });
    }

    // Resolve approvers for the COI workflow
    const workflowService = new CoiWorkflowService(orgId);
    const approvers = await workflowService.resolveApprovers(coiRule, null);

    const approvalSteps = approvers.map(approver => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    // Create external COI request with approval workflow already configured
    const coiRepo = new CoiRequestRepository(tenantDb);
    const externalCoi = await coiRepo.create({
      org_id: org._id,
      submission_source: 'external',
      is_external: true,
      external_submitter: {
        name: external_submitter.name,
        email: external_submitter.email,
        phone: external_submitter.phone || null
      },
      coi_reason,
      conflict_person_name,
      conflict_person_details,
      // Approval workflow configured immediately
      approval_matrix_id: coiMatrix._id,
      approval_type: coiRule.approval_type || 'sequential',
      approval_steps: approvalSteps,
      // These fields will be populated when admin assigns it to a risk/approval workflow
      parent_approval_request_id: null,
      parent_step_index: null,
      parent_entity_id: null,
      parent_entity_type: null,
      submitted_by: null,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Conflict of interest submitted successfully. Our team will review it shortly.',
      data: {
        coi_id: externalCoi._id,
        submitted_at: externalCoi.created_at
      }
    });
  } catch (error) {
    console.error('External COI submission error:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'SUBMISSION_ERROR',
        message: 'Failed to submit conflict of interest. Please try again.'
      }
    });
  }
});

// Admin endpoint: Assign external COI to a module (risk, finance, etc)
export const assignExternalCoiToModule = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { coiRequestId } = req.params;
  const { module, module_id } = req.body;

  if (!module || !module_id) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Module and module_id are required'
      }
    });
  }

  try {
    const tenantDb = await getTenantConnection(orgId);
    const coiRepo = new CoiRequestRepository(tenantDb);
    const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
    const orgRepo = new OrganizationRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get the COI request
    const coiRequest = await coiRepo.findById(coiRequestId);
    if (!coiRequest) {
      return res.status(404).json({
        success: false,
        error: { code: 'COI_NOT_FOUND', message: 'COI request not found' }
      });
    }

    // Only external COIs can be assigned via this endpoint
    if (coiRequest.submission_source !== 'external') {
      return res.status(400).json({
        success: false,
        error: { 
          code: 'INTERNAL_COI',
          message: 'Only external COIs can be assigned to modules'
        }
      });
    }

    // Find active approval request for this module entity
    const activeApprovalRequest = await approvalRequestRepo.findActiveByEntity(module, module_id);

    // Update COI with module linkage
    const coiUpdate = {
      linked_module: module,
      linked_module_id: module_id,
      status: 'pending'
    };

    // If there's an active approval request, pause it for COI
    if (activeApprovalRequest) {
      coiUpdate.parent_approval_request_id = activeApprovalRequest._id;
      coiUpdate.parent_entity_id = activeApprovalRequest.entity_id;
      coiUpdate.parent_entity_type = activeApprovalRequest.entity_type;

      // Pause the approval workflow
      await approvalRequestRepo.update(activeApprovalRequest._id, {
        status: 'paused_for_coi',
        paused_at: new Date(),
        current_coi_request_id: coiRequestId,
        $addToSet: { coi_request_ids: coiRequestId }
      });
    }

    await coiRepo.update(coiRequestId, coiUpdate);
    
    res.json({
      success: true,
      data: await coiRepo.findById(coiRequestId),
      message: activeApprovalRequest 
        ? `COI assigned to ${module} and approval workflow has been paused pending COI resolution`
        : `COI assigned to ${module}. No active approval workflow found.`
    });
  } catch (error) {
    console.error('Error assigning external COI:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

export const assignCoiToWorkflow = asyncHandler(async (req, res) => {
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
  const { coiRequestId } = req.params;
  const { approval_request_id, step_index } = req.body;

  try {
    const tenantDb = await getTenantConnection(orgId);
    const coiRepo = new CoiRequestRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const { ApprovalMatrixRepository } = await import('../repositories/approvalMatrixRepository.js');
    const matrixRepo = new ApprovalMatrixRepository(tenantDb);

    // Get the COI request
    const coiRequest = await coiRepo.findById(coiRequestId);
    if (!coiRequest) {
      return res.status(404).json({
        success: false,
        error: { code: 'COI_NOT_FOUND', message: 'COI request not found' }
      });
    }

    // Get the approval request to pause
    const approvalRequest = await approvalRequestRepo.findById(approval_request_id);
    if (!approvalRequest) {
      return res.status(404).json({
        success: false,
        error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval request not found' }
      });
    }

    // If this is a risk-related approval, verify the risk is under treatment, not resolved
    if (approvalRequest.entity_type === 'risk') {
      const { RiskRepository } = await import('../repositories/riskRepository.js');
      const riskRepo = new RiskRepository(tenantDb);
      const risk = await riskRepo.findById(approvalRequest.entity_id);
      
      if (!risk) {
        return res.status(404).json({
          success: false,
          error: { code: 'RISK_NOT_FOUND', message: 'Risk not found' }
        });
      }

      if (risk.status === 'resolved') {
        return res.status(400).json({
          success: false,
          error: { 
            code: 'INVALID_RISK_STATUS', 
            message: 'Cannot assign COI to a resolved risk. COI can only be assigned to risks under treatment.' 
          }
        });
      }
    }

    // Get COI workflow matrix
    const matrices = await matrixRepo.findByOrgId(orgId);
    const coiMatrix = matrices?.find(matrix => 
      matrix.rules?.some(rule => rule.action_type === 'coi' && rule.is_active)
    );
    
    if (!coiMatrix) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_COI_MATRIX', message: 'COI workflow not configured' }
      });
    }
    
    const coiRule = coiMatrix.rules.find(rule => rule.action_type === 'coi' && rule.is_active);
    if (!coiRule) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_COI_RULE', message: 'No active COI rule found' }
      });
    }

    // Get approvers for COI workflow
    const workflowService = new CoiWorkflowService(orgId);
    const approvers = await workflowService.resolveApprovers(coiRule, null);

    const approvalSteps = approvers.map(approver => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    // Update COI with approval workflow details
    await coiRepo.update(coiRequestId, {
      parent_approval_request_id: approval_request_id,
      parent_step_index: step_index,
      parent_entity_id: approvalRequest.entity_id,
      parent_entity_type: approvalRequest.entity_type,
      approval_matrix_id: coiMatrix._id,
      approval_type: coiRule.approval_type || 'sequential',
      approval_steps: approvalSteps,
      submitted_by: userId,
      status: 'pending'
    });

    // Pause the original approval workflow
    await approvalRequestRepo.update(approval_request_id, {
      status: 'paused_for_coi',
      paused_step_index: step_index,
      paused_at: new Date(),
      current_coi_request_id: coiRequestId,
      $addToSet: { coi_request_ids: coiRequestId }
    });

    res.json({
      success: true,
      message: 'COI assigned to approval workflow. The workflow is now paused pending COI resolution.',
      data: {
        coi_id: coiRequestId,
        approval_request_id,
        status: 'paused_for_coi'
      }
    });
  } catch (error) {
    console.error('Assign COI to workflow error:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'ASSIGNMENT_ERROR',
        message: 'Failed to assign COI to workflow. Please try again.'
      }
    });
  }
});

export default {
  listCoiRequests,
  getPendingCoiRequests,
  debugGetAllCoi,
  getCoiRequestById,
  approveCoiRequest,
  rejectCoiRequest,
  getParentApprovalForCoi,
  submitExternalCoi,
  assignExternalCoiToModule,
  assignCoiToWorkflow
};
