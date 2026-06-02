/**
 * Donor Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { validate } from '../../middleware/validation.js';
import { uploadDonorKycFiles, handleUploadError } from '../../middleware/upload.js';
import {
  createDonor,
  listDonors,
  getDonorById,
  updateDonor,
  uploadDonorKycDocuments,
  initiateDonorRefund,
  createManualDonorRefund,
  listDonorRefunds,
  getRefundById,
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
router.use(requireFeatureFlag('governance.organisation'));

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

// Get a single refund by id — used by the approval detail page so the
// approver can see who / what they're approving. Works for BOTH donor
// and project refunds (same physical collection). Mounted BEFORE the
// other parameterised refund routes so the literal `/refunds/manual`
// still wins for its specific path.
router.get(
  '/refunds/by-id/:refundId',
  [param('refundId').isMongoId().withMessage('Invalid refund ID')],
  validate,
  getRefundById
);

// Manual refund entry — bookkeeping for small donors not in the system.
// Mounted BEFORE the parameterised /:donorId/refunds/initiate route so
// the literal "/refunds/manual" wins the URL race.
router.post(
  '/refunds/manual',
  [
    body('manual_donor_name').trim().notEmpty().withMessage('Donor name is required'),
    body('manual_donor_email').optional({ checkFalsy: true }).isEmail().withMessage('Donor email must be valid'),
    body('manual_refund_amount').isFloat({ gt: 0 }).withMessage('Refund amount must be greater than 0'),
    body('manual_refund_date').optional().trim(),
    body('manual_receipt_number').optional().trim(),
    body('manual_payment_method').optional().trim(),
    body('manual_reason').optional().trim()
  ],
  validate,
  createManualDonorRefund
);

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

