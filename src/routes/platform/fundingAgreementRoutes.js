/**
 * Funding Agreement Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as fundingAgreementController from '../../controllers/fundingAgreementController.js';

const router = express.Router();

// Public routes (token-based, no auth required)
router.get(
  '/public/sign/:token',
  [param('token').notEmpty().withMessage('Token is required')],
  validate,
  fundingAgreementController.getPublicAgreementForSigning
);

router.post(
  '/public/sign/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('signer_name').trim().notEmpty().withMessage('Signer name is required'),
    body('signer_email').optional().isEmail().withMessage('Signer email must be valid if provided'),
    body('signature_data').notEmpty().withMessage('Signature is required')
  ],
  validate,
  fundingAgreementController.submitPartnerSignature
);

router.use(authAndResolveTenant);

router.get('/counts', fundingAgreementController.getAgreementCounts);

router.post(
  '/',
  [
    body('agreement_title').trim().notEmpty().withMessage('Agreement title is required'),
    body('partner_name').optional().trim(),
    body('partner_email').optional().isEmail().withMessage('Partner email must be valid if provided'),
    body('agreement_type').optional().trim(),
    body('currency').optional().trim(),
    body('total_amount').optional().isNumeric(),
    body('status').optional().isIn(['pending', 'approved', 'rejected']),
    body('start_date').optional().isISO8601().toDate(),
    body('end_date').optional().isISO8601().toDate(),
    body('payment_terms').optional().trim(),
    body('reporting_requirements').optional().trim()
  ],
  validate,
  fundingAgreementController.createAgreement
);

router.get(
  '/',
  [
    query('status').optional().isIn(['pending', 'approved', 'rejected']),
    query('search').optional().trim()
  ],
  validate,
  fundingAgreementController.getAgreements
);

router.get(
  '/:agreementId',
  [param('agreementId').isMongoId().withMessage('Invalid agreement ID')],
  validate,
  fundingAgreementController.getAgreementById
);

router.post(
  '/:agreementId/sign/internal',
  [
    param('agreementId').isMongoId().withMessage('Invalid agreement ID'),
    body('signature_data').notEmpty().withMessage('Signature is required'),
    body('notes').optional().isString(),
    body('partner_email').optional().isEmail().withMessage('Partner email must be valid if provided')
  ],
  validate,
  fundingAgreementController.signAgreementInternallyAndEmailPartner
);

export default router;
