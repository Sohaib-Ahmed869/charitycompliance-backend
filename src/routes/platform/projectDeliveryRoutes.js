/**
 * Project delivery / handoff routes
 */

import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { body, param, query } from 'express-validator';
import * as projectDeliveryController from '../../controllers/projectDeliveryController.js';

const router = express.Router();

// Public partner endpoints (token-based, no auth)
router.post(
  '/refunds/public/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('notes').optional().isString(),
    body('receipts').optional().isArray(),
  ],
  validate,
  projectDeliveryController.submitRefundPartnerResponse
);

router.post(
  '/delivery-changes/public/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('notes').optional().isString(),
    body('explanation').optional().isString(),
    body('receipts').optional().isArray(),
  ],
  validate,
  projectDeliveryController.submitDeliveryChangePartnerResponse
);

// Internal endpoints (auth required)
router.use(authAndResolveTenant);

router.post(
  '/:projectId/updates',
  [
    param('projectId').isMongoId().withMessage('Invalid projectId'),
    body('entry_date').optional().isISO8601().toDate(),
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('entry_type').optional().isIn(['report', 'media']).withMessage('entry_type must be report or media'),
    body('notes').optional().isString(),
    body('files').optional().isArray(),
    body('files.*.url').optional().isString(),
    body('files.*.name').optional().isString(),
    body('files.*.file_name').optional().isString(),
    body('files.*.key').optional().isString(),
    body('files.*.size').optional().isNumeric(),
    body('files.*.type').optional().isString()
  ],
  validate,
  projectDeliveryController.addProjectUpdateEntry
);

router.post(
  '/:projectId/complete',
  [param('projectId').isMongoId().withMessage('Invalid projectId')],
  validate,
  projectDeliveryController.completeProject
);

router.post(
  '/:projectId/extra-expense',
  [
    param('projectId').isMongoId().withMessage('Invalid projectId'),
    body('amount').isNumeric().withMessage('amount must be numeric'),
    body('admin_details').trim().notEmpty().withMessage('admin_details is required')
  ],
  validate,
  projectDeliveryController.addProjectExtraExpense
);

router.post(
  '/materials/:projectId/submit',
  [
    param('projectId').isMongoId().withMessage('Invalid projectId'),
    body('files').optional().isArray(),
    body('files.*.url').optional().isString(),
    body('files.*.key').optional().isString(),
    body('files.*.file_name').optional().isString(),
    body('files.*.name').optional().isString(),
    body('files.*.size').optional().isNumeric(),
    body('files.*.type').optional().isString()
  ],
  validate,
  projectDeliveryController.submitProjectDeliveryMaterials
);

router.get(
  '/refunds',
  [
    query('projectId').optional().isMongoId().withMessage('Invalid projectId')
  ],
  validate,
  projectDeliveryController.listProjectRefunds
);

router.post(
  '/refunds/:refundId/initiate',
  [param('refundId').isMongoId().withMessage('Invalid refundId')],
  validate,
  projectDeliveryController.initiateRefundProcess
);

router.get(
  '/delivery-changes',
  [
    query('projectId').optional().isMongoId().withMessage('Invalid projectId')
  ],
  validate,
  projectDeliveryController.listProjectDeliveryChanges
);

export default router;

