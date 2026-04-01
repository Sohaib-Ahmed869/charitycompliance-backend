/**
 * Partner Vetting Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as partnerVettingController from '../../controllers/partnerVettingController.js';
import { uploadPolicySingle, handlePolicyUploadError } from '../../middleware/upload.js';

const router = express.Router();

// Public partner COI (token-based, no auth)
router.get(
  '/public/coi/:token/context',
  [param('token').notEmpty().withMessage('Token is required')],
  validate,
  partnerVettingController.getPublicPartnerCoiContext
);

router.post(
  '/public/coi/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('external_submitter.name').trim().notEmpty().withMessage('Submitter name is required'),
    body('external_submitter.email').optional().isEmail().withMessage('Valid email is required if provided'),
    body('external_submitter.phone').optional().trim(),
    body('coi_reason').trim().notEmpty().withMessage('Conflict of interest description is required'),
    body('conflict_person_name').trim().notEmpty().withMessage('Person in conflict name is required'),
    body('conflict_person_details').trim().notEmpty().withMessage('Person in conflict details are required'),
  ],
  validate,
  partnerVettingController.submitPublicPartnerCoi
);

router.use(authAndResolveTenant);

router.get('/counts', partnerVettingController.getPartnerCounts);

router.post(
  '/',
  [
    body('organization_name').trim().notEmpty().withMessage('Organization name is required'),
    body('contact.email').optional().isEmail().withMessage('Primary contact email must be valid'),
    body('contact_email').optional().isEmail().withMessage('Primary contact email must be valid'),
    body().custom((value) => {
      const email = value?.contact?.email || value?.contact_email || '';
      if (!String(email).trim()) {
        throw new Error('Primary contact email is required');
      }
      return true;
    }),
    body('country').optional().trim(),
    body('status').optional().isIn(['pending', 'approved', 'rejected']),
    body('risk_rating').optional().isIn(['low', 'medium', 'high']),
    body('review_date').optional().isISO8601().toDate()
  ],
  validate,
  partnerVettingController.createPartner
);

router.get(
  '/',
  [
    query('status').optional().isIn(['pending', 'approved', 'rejected']),
    query('search').optional().trim()
  ],
  validate,
  partnerVettingController.getPartners
);

router.get(
  '/:partnerId',
  [param('partnerId').isMongoId().withMessage('Invalid partner ID')],
  validate,
  partnerVettingController.getPartnerById
);

router.put(
  '/:partnerId',
  [
    param('partnerId').isMongoId().withMessage('Invalid partner ID'),
    body('organization_name').optional().trim().notEmpty(),
    body('status').optional().isIn(['pending', 'approved', 'rejected']),
    body('risk_rating').optional().isIn(['low', 'medium', 'high']),
    body('risk_assessment.overall_risk_rating').optional().isIn(['low', 'medium', 'high']),
    body('risk_assessment.review_date').optional().isISO8601().toDate()
  ],
  validate,
  partnerVettingController.updatePartner
);

router.post(
  '/:partnerId/documents/:docIndex/upload',
  [
    param('partnerId').isMongoId().withMessage('Invalid partner ID'),
    param('docIndex').isInt({ min: 0 }).withMessage('Invalid document index')
  ],
  validate,
  uploadPolicySingle,
  handlePolicyUploadError,
  partnerVettingController.uploadPartnerDocument
);

router.get(
  '/:partnerId/documents/:docIndex/stream',
  [
    param('partnerId').isMongoId().withMessage('Invalid partner ID'),
    param('docIndex').isInt({ min: 0 }).withMessage('Invalid document index')
  ],
  validate,
  partnerVettingController.streamPartnerDocument
);

router.post(
  '/:partnerId/vetting-checks/:checkIndex/documents/upload',
  [
    param('partnerId').isMongoId().withMessage('Invalid partner ID'),
    param('checkIndex').isInt({ min: 0 }).withMessage('Invalid check index')
  ],
  validate,
  uploadPolicySingle,
  handlePolicyUploadError,
  partnerVettingController.uploadVettingCheckDocument
);

router.get(
  '/:partnerId/vetting-checks/:checkIndex/documents/:docIndex/stream',
  [
    param('partnerId').isMongoId().withMessage('Invalid partner ID'),
    param('checkIndex').isInt({ min: 0 }).withMessage('Invalid check index'),
    param('docIndex').isInt({ min: 0 }).withMessage('Invalid document index')
  ],
  validate,
  partnerVettingController.streamVettingCheckDocument
);

router.delete(
  '/:partnerId',
  [param('partnerId').isMongoId().withMessage('Invalid partner ID')],
  validate,
  partnerVettingController.deletePartner
);

router.post(
  '/:partnerId/start-coi',
  [param('partnerId').isMongoId().withMessage('Invalid partner ID')],
  validate,
  partnerVettingController.startPartnerCoi
);

export default router;
