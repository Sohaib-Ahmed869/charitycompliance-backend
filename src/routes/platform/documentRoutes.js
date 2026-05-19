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
      .isIn(['governing_document', 'constitution', 'trust_deed', 'certificate_of_incorporation', 'board_minutes', 'financial_statement', 'fiscal_report', 'bas_lodgement', 'responsible_person_consent', 'evidence_of_activities', 'supporting_document', 'withholding_evidence', 'registration_license', 'licences_permits', 'other'])
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
      .isIn(['governing_document', 'constitution', 'trust_deed', 'certificate_of_incorporation', 'board_minutes', 'financial_statement', 'fiscal_report', 'bas_lodgement', 'responsible_person_consent', 'evidence_of_activities', 'supporting_document', 'withholding_evidence', 'registration_license', 'licences_permits', 'other'])
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
    body('review_date')
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

// Replace fiscal / BAS file during resubmission (multipart)
router.post(
  '/:documentId/replace-workflow-file',
  uploadSingle,
  handleUploadError,
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.replaceWorkflowDocumentFile
);

// Update document. Accepts BOTH application/json and multipart/form-data
// payloads — the latter is used when the caller wants to replace the
// document's file at the same time. Without multer on the PUT route,
// FormData bodies would never be parsed and field updates would silently
// no-op.
router.put(
  '/:documentId',
  uploadSingle,
  handleUploadError,
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.updateDocument
);

// List all versions for a parent document (chronological, newest version first)
router.get(
  '/:documentId/versions',
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.getDocumentVersions
);

// Upload a new version of an existing document. Multipart payload —
// the new file goes to S3, metadata is copied from the parent unless
// overridden in the body, and the version row is linked to the parent
// via parent_document_id. The parent stays the "head"; old versions
// are accessible via /:id/versions.
router.post(
  '/:documentId/versions',
  uploadSingle,
  handleUploadError,
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID')
  ],
  validate,
  documentController.uploadDocumentVersion
);

// Review and sign yearly statement (assigned board member only)
router.post(
  '/:documentId/review',
  [
    param('documentId')
      .isMongoId()
      .withMessage('Invalid document ID'),
    body('signature')
      .trim()
      .notEmpty()
      .withMessage('Signature is required')
  ],
  validate,
  documentController.reviewYearlyStatement
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
