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

  res.json({
    success: true,
    data: approvalRequest
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
  const matrix = allMatrices.find((m) => {
    const rule = m.rules && m.rules[0];
    return rule && (rule.action_type === mappedType || rule.action_type === actionType);
  });

  if (!matrix) {
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

  const rule = matrix.rules[0];
  rule.requires_approval_from = requiresApprovalFrom;
  matrix.markModified('rules');
  await matrix.save();

  res.json({
    success: true,
    message: 'Workflow positions updated',
    data: { matrixId: matrix._id, actionType: mappedType }
  });
});
