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
import { uploadAcknowledgementFiles, handleUploadError } from '../../middleware/upload.js';

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

// Download approval workflow PDF
router.get(
  '/:approvalRequestId/download-pdf',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.downloadApprovalPDF
);

// Upload acknowledgement files
router.post(
  '/upload-acknowledgement',
  uploadAcknowledgementFiles,
  handleUploadError,
  approvalController.uploadAcknowledgementFiles
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

// Approve risk with likelihood and severity (department head only)
// This endpoint is called when the department head approves a risk
// and selects likelihood/severity, which auto-calculates priority and determines the workflow
router.post(
  '/:approvalRequestId/approve-with-priority',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('likelihood')
      .isInt({ min: 1, max: 5 })
      .withMessage('Likelihood must be between 1 and 5'),
    body('severity')
      .isInt({ min: 1, max: 5 })
      .withMessage('Severity must be between 1 and 5'),
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

// Submit COI request (pauses main workflow)
router.post(
  '/:approvalRequestId/coi',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('reason')
      .trim()
      .notEmpty()
      .withMessage('COI reason is required')
  ],
  validate,
  approvalController.submitCoiRequest
);

// Rejection Workflow Routes

// Get pending rejection reviews for current user
router.get('/rejection-reviews/pending', approvalController.getPendingRejectionReviews);

// Get workflow participants (for rejection forwarding)
router.get(
  '/:approvalRequestId/participants',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.getWorkflowParticipants
);

// Forward rejection for review
router.post(
  '/:approvalRequestId/forward-rejection',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('forwardToUserId')
      .isMongoId()
      .withMessage('Valid forward to user ID is required'),
    body('rejectionComments')
      .trim()
      .notEmpty()
      .withMessage('Rejection reason is required')
  ],
  validate,
  approvalController.forwardRejection
);

// Review rejection (accept or reject the rejection)
router.post(
  '/:approvalRequestId/review-rejection',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('reviewAction')
      .trim()
      .notEmpty()
      .withMessage('Review action is required')
      .isIn(['accept_rejection', 'reject_rejection'])
      .withMessage('Review action must be accept_rejection or reject_rejection'),
    body('reviewComments')
      .trim()
      .notEmpty()
      .withMessage('Review comments are required')
  ],
  validate,
  approvalController.reviewRejection
);

export default router;
