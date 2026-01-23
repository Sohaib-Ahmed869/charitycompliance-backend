/**
 * Approval Controller
 * 
 * Handles HTTP requests for approval workflows
 */

import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';

export const getPendingApprovals = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user._id;

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
  const userId = req.user._id;
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
  const userId = req.user._id;
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
