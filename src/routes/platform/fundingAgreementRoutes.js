/**
 * Funding Agreement Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as fundingAgreementController from '../../controllers/fundingAgreementController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/counts', fundingAgreementController.getAgreementCounts);

router.post(
  '/',
  [
    body('agreement_title').trim().notEmpty().withMessage('Agreement title is required'),
    body('partner_name').optional().trim(),
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

export default router;
