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
