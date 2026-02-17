/**
 * Document Routes
 * 
 * API routes for document management
 */

import express from 'express';
import * as documentController from '../../controllers/documentController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get all documents
router.get(
  '/',
  [
    query('category')
      .optional()
      .isIn(['governing_document', 'constitution', 'trust_deed', 'certificate_of_incorporation', 'board_minutes', 'financial_statement', 'responsible_person_consent', 'evidence_of_activities', 'supporting_document', 'withholding_evidence', 'registration_license', 'other'])
      .withMessage('Invalid category')
  ],
  validate,
  documentController.getDocuments
);

// Get document by ID
router.get(
  '/:documentId',
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.getDocumentById
);

// Create document (with file upload)
router.post(
  '/',
  uploadSingle,
  handleUploadError,
  [
    body('category')
      .isIn(['governing_document', 'constitution', 'trust_deed', 'certificate_of_incorporation', 'board_minutes', 'financial_statement', 'responsible_person_consent', 'evidence_of_activities', 'supporting_document', 'withholding_evidence', 'registration_license', 'other'])
      .withMessage('Valid category is required'),
    body('document_type')
      .trim()
      .notEmpty()
      .withMessage('Document type is required'),
    body('registration_number')
      .optional()
      .trim(),
    body('title')
      .trim()
      .notEmpty()
      .withMessage('Title is required'),
    body('date_adopted')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
    body('date_last_amended')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
    body('effective_date')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
    body('expiry_date')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format')
  ],
  validate,
  documentController.createDocument
);

// Update document
router.put(
  '/:documentId',
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.updateDocument
);

// Delete document
router.delete(
  '/:documentId',
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.deleteDocument
);

export default router;
