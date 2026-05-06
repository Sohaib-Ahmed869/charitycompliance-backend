/**
 * Donor Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validation.js';
import { uploadDonorKycFiles, handleUploadError } from '../../middleware/upload.js';
import {
  createDonor,
  listDonors,
  getDonorById,
  updateDonor,
  uploadDonorKycDocuments,
  initiateDonorRefund,
  listDonorRefunds,
  submitDonorRefundPublicForm,
  getDonorRefundPaymentAckContext,
  submitDonorRefundPaymentAck,
  startDonorRefundProcessing,
  recordDonorRefundPaymentSent,
  completeDonorRefundProcessing,
  initiateDonorRefundWorkflow
} from '../../controllers/donorController.js';

const router = express.Router();

// Public donor refund endpoints (token-based, no auth)
router.post(
  '/refunds/public/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('donation_date').trim().notEmpty().withMessage('Donation date is required'),
    body('donation_amount').isNumeric().withMessage('Donation amount is required'),
    body('payment_method').trim().notEmpty().withMessage('Payment method is required'),
    body('reason').trim().notEmpty().withMessage('Reason is required'),
    body('notes').optional().isString(),
    body('evidence').isArray({ min: 1 }).withMessage('At least one evidence file is required'),
  ],
  validate,
  submitDonorRefundPublicForm
);

// Helpful guard: if someone opens the submit URL in browser (GET),
// do not run auth middleware; explain correct method instead.
router.get(
  '/refunds/public/:token/submit',
  [param('token').notEmpty().withMessage('Token is required')],
  validate,
  (req, res) => {
    res.status(405).json({
      success: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'This endpoint only accepts POST submissions from the public refund form.'
      }
    });
  }
);

router.get(
  '/refunds/public/payment-ack/:token',
  [param('token').notEmpty().withMessage('Token is required')],
  validate,
  getDonorRefundPaymentAckContext
);

router.post(
  '/refunds/public/payment-ack/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('signer_name').trim().notEmpty().withMessage('Signer name is required'),
    body('confirm_received').isBoolean().withMessage('confirm_received must be boolean'),
    body('notes').optional().isString(),
  ],
  validate,
  submitDonorRefundPaymentAck
);

router.use(authAndResolveTenant);

router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Donor name is required'),
    body('donor_type').optional().isIn(['individual', 'corporate', 'foundation', 'government', 'other']),
    body('email').optional().isEmail().withMessage('Primary contact email must be valid')
  ],
  validate,
  createDonor
);

router.get(
  '/',
  [
    query('status').optional().isString(),
    query('search').optional().trim()
  ],
  validate,
  listDonors
);

// Upload donor KYC documents
router.post(
  '/:donorId/kyc/upload',
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  uploadDonorKycFiles,
  handleUploadError,
  uploadDonorKycDocuments
);

// Donor refunds (internal)
router.get('/refunds', listDonorRefunds);

router.post(
  '/:donorId/refunds/initiate',
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  initiateDonorRefund
);

router.post(
  '/refunds/:refundId/workflow/initiate',
  [param('refundId').isMongoId().withMessage('Invalid refund ID')],
  validate,
  initiateDonorRefundWorkflow
);

router.post(
  '/refunds/:refundId/process/start',
  [param('refundId').isMongoId().withMessage('Invalid refund ID')],
  validate,
  startDonorRefundProcessing
);

router.post(
  '/refunds/:refundId/process/payment-sent',
  [param('refundId').isMongoId().withMessage('Invalid refund ID')],
  validate,
  recordDonorRefundPaymentSent
);

router.post(
  '/refunds/:refundId/process/complete',
  [param('refundId').isMongoId().withMessage('Invalid refund ID')],
  validate,
  completeDonorRefundProcessing
);

// Donor detail routes must come AFTER "/refunds" routes
router.get(
  '/:donorId',
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  getDonorById
);

// `requirePermission('module:grants_donors:edit')` already covers admin/owner
// (their wildcard `*:*` permission satisfies it) AND non-admin users whose
// position grants module:grants_donors:edit — which is exactly what the FE
// relies on for the Save button. The earlier `requireAdminOrOwner` gate was
// stricter than the FE expected, so position-permitted users could open the
// edit form but their saves came back 403.
router.put(
  '/:donorId',
  requirePermission('module:grants_donors:edit'),
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  updateDonor
);

export default router;

