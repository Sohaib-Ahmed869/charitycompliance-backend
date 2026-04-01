/**
 * Legal Document Routes
 * 
 * API routes for legal document management
 */

import express from 'express';
import * as legalDocController from '../../controllers/legalDocumentController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.post(
  '/',
  uploadSingle,
  handleUploadError,
  [
    body('document_name').notEmpty().withMessage('Document name is required').trim(),
    body('category').notEmpty().withMessage('Category is required').isIn(['mou', 'sponsorship_agreement', 'contract', 'lease_agreement', 'grant_agreement', 'sla', 'ambassadors_insurance', 'other'])
      .withMessage('Invalid category type'),
    body('category_other_text').optional({ values: 'falsy' }).trim(),
    body('effective_date').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid date format'),
    body('expiry_date').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid date format'),
    body('review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid date format'),
    body('owner_id').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid owner ID')
  ],
  validate,
  legalDocController.createDocument
);

router.get(
  '/',
  [
    query('status').optional().isIn(['active', 'expired', 'archived']),
    query('category').optional().isIn(['mou', 'sponsorship_agreement', 'contract', 'lease_agreement', 'grant_agreement', 'sla', 'ambassadors_insurance', 'other']),
    query('search').optional().trim()
  ],
  validate,
  legalDocController.getDocuments
);

router.get('/stats', legalDocController.getStats);

router.get(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid document ID')],
  validate,
  legalDocController.getDocumentById
);

router.put(
  '/:id',
  [
    param('id').isMongoId().withMessage('Invalid document ID'),
    body('document_name').optional().trim(),
    body('category').optional({ values: 'falsy' }).isIn(['mou', 'sponsorship_agreement', 'contract', 'lease_agreement', 'grant_agreement', 'sla', 'ambassadors_insurance', 'other']),
    body('category_other_text').optional({ values: 'falsy' }).trim(),
    body('status').optional({ values: 'falsy' }).isIn(['active', 'expired', 'archived']),
    body('effective_date').optional({ values: 'falsy' }).isISO8601(),
    body('expiry_date').optional({ values: 'falsy' }).isISO8601(),
    body('review_date').optional({ values: 'falsy' }).isISO8601(),
    body('owner_id').optional({ values: 'falsy' }).isMongoId()
  ],
  validate,
  legalDocController.updateDocument
);

router.post(
  '/:id/versions',
  uploadSingle,
  handleUploadError,
  [param('id').isMongoId().withMessage('Invalid document ID')],
  validate,
  legalDocController.uploadNewVersion
);

router.post(
  '/:id/archive',
  [param('id').isMongoId().withMessage('Invalid document ID')],
  validate,
  legalDocController.archiveDocument
);

router.get(
  '/:id/download/:versionNumber',
  [
    param('id').isMongoId().withMessage('Invalid document ID'),
    param('versionNumber').isInt({ min: 1 }).withMessage('Invalid version number')
  ],
  validate,
  legalDocController.downloadVersion
);

router.delete(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid document ID')],
  validate,
  legalDocController.deleteDocument
);

export default router;
