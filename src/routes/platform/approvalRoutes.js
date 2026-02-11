/**
 * Approval Routes
 * 
 * API routes for approval workflows
 */

import express from 'express';
import * as approvalController from '../../controllers/approvalController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All approval routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get approval matrices (workflows)
router.get('/matrices', approvalController.getApprovalMatrices);

// Create approval matrix (workflow)
router.post(
  '/matrices',
  [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Workflow name is required'),
    body('action_type')
      .trim()
      .notEmpty()
      .withMessage('Workflow type is required'),
    body('priority')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Priority must be a non-negative integer'),
    body('priority_level')
      .optional()
      .isIn(['high', 'medium', 'low'])
      .withMessage('Priority level must be high, medium, or low'),
    body('description')
      .optional()
      .trim(),
    body('positions')
      .optional()
      .isArray()
      .withMessage('Positions must be an array')
  ],
  validate,
  approvalController.createApprovalMatrix
);

// Update approval matrix (workflow)
router.put(
  '/matrices/:matrixId',
  [
    param('matrixId')
      .isMongoId()
      .withMessage('Invalid matrix ID'),
    body('name')
      .optional()
      .trim(),
    body('description')
      .optional()
      .trim(),
    body('priority')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Priority must be a non-negative integer'),
    body('priority_level')
      .optional()
      .isIn(['high', 'medium', 'low'])
      .withMessage('Priority level must be high, medium, or low'),
    body('positions')
      .optional()
      .isArray()
      .withMessage('Positions must be an array')
  ],
  validate,
  approvalController.updateApprovalMatrix
);

// List all approval requests for the org (optional status filter)
router.get('/list', approvalController.listApprovalRequests);

// Update workflow positions for an action type
router.put(
  '/workflows/:actionType',
  [
    body('positions')
      .isArray()
      .withMessage('positions must be an array'),
    body('positions.*')
      .custom((pos) => (pos.positionId || pos.id) && typeof (pos.positionId || pos.id) === 'string')
      .withMessage('Each position must have positionId or id'),
    body('positions.*.approvalLevel')
      .optional()
      .isInt({ min: 1 })
      .withMessage('approvalLevel must be a positive integer')
  ],
  validate,
  approvalController.updateWorkflowPositions
);

// Get pending approvals for current user
router.get('/pending', approvalController.getPendingApprovals);

// Get approval request by ID
router.get(
  '/:approvalRequestId',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.getApprovalRequestById
);

// Approve request
router.post(
  '/:approvalRequestId/approve',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('comments')
      .optional()
      .trim()
  ],
  validate,
  approvalController.approveRequest
);

// Approve risk with priority selection (department head only)
// This endpoint is called when the department head approves a risk
// and selects the risk priority, which determines the workflow
router.post(
  '/:approvalRequestId/approve-with-priority',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('riskPriority')
      .trim()
      .notEmpty()
      .withMessage('Risk priority is required')
      .isIn(['low', 'medium', 'high'])
      .withMessage('Risk priority must be low, medium, or high'),
    body('comments')
      .optional()
      .trim()
  ],
  validate,
  approvalController.approveRiskWithPriority
);

// Reject request
router.post(
  '/:approvalRequestId/reject',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('comments')
      .trim()
      .notEmpty()
      .withMessage('Rejection reason is required')
  ],
  validate,
  approvalController.rejectRequest
);

export default router;
