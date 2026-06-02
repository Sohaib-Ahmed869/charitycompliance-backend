/**
 * Inquiry routes
 *
 * Two resources mounted under /platform/inquiries:
 *   - /templates           — InquiryTemplate CRUD
 *   - /templates/:id/records — create a record against a template
 *   - /records             — list / get / approve / reject
 *
 * Record submission accepts a multipart payload (JSON string in
 * `record_payload` + one file per document-type field, named
 * `file__<field_key>`). `upload.any()` is used because the field
 * names are dynamic.
 */

import express from 'express';
import multer from 'multer';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { handleUploadError } from '../../middleware/upload.js';
import * as inquiryController from '../../controllers/inquiryController.js';

const router = express.Router();
router.use(authAndResolveTenant);

// Dynamic-fieldname uploader for the record creation endpoint.
// 50 MB cap per file mirrors what other registers allow; tighten if
// document storage cost becomes a concern.
const recordUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 25 }
});

/* ---------- Uploads ---------- */

// Single-file uploader used by the template builder when the user
// attaches a "default file" to a document field. Returns the S3 key
// the field can be saved against. Lives at the top of the router so
// it isn't shadowed by the `/templates/:templateId` literal.
const defaultFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }
}).single('file');

router.post(
  '/uploads/default-file',
  defaultFileUpload,
  inquiryController.uploadFieldDefaultFile
);

/* ---------- Templates ---------- */

const ALLOWED_PARENT_TYPES = ['donor', 'project', 'employee', 'volunteer', 'supplier', 'bank', 'authority', 'custom'];

const templateValidators = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 120 }),
  body('parent_entity_type').isIn(ALLOWED_PARENT_TYPES).withMessage('Invalid parent entity type'),
  body('description').optional().isString(),
  // Free-text label is required when parent_entity_type is 'custom'.
  body('parent_entity_type_label')
    .if((value, { req }) => req.body.parent_entity_type === 'custom')
    .trim()
    .notEmpty()
    .withMessage('Custom entity types need a label (e.g. "External Consultant")')
    .isLength({ max: 60 })
    .withMessage('Custom entity label must be 60 characters or fewer'),
  body('custom_fields').isArray({ min: 0 }).withMessage('custom_fields must be an array'),
  body('custom_fields.*.key').matches(/^[a-z][a-z0-9_]*$/).withMessage('Field key must be snake_case (lowercase, digits, underscores)'),
  body('custom_fields.*.label').trim().notEmpty().withMessage('Field label is required'),
  body('custom_fields.*.type').isIn(['text', 'document']).withMessage('Field type must be text or document'),
  body('custom_fields.*.default_value').optional().isString(),
  // Document fields can optionally carry a default file (the s3 key
  // returned by /uploads/default-file). String validators only —
  // existence checks happen on actual download.
  body('custom_fields.*.default_file_key').optional().isString(),
  body('custom_fields.*.default_file_name').optional().isString(),
  body('custom_fields.*.default_file_mime').optional().isString(),
  body('workflow_steps').isArray({ min: 1 }).withMessage('At least one workflow step is required'),
  body('workflow_steps.*.name').trim().notEmpty().withMessage('Step name is required'),
  body('workflow_steps.*.approver_type').isIn(['user', 'position', 'board_member']).withMessage('Invalid approver type'),
  // Friendly mirror of the schema's pre-validate hook — surfaces
  // the rule as a 400 with a clear message instead of a 500.
  body('workflow_steps').custom((steps) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('At least one workflow step is required');
    }
    const last = steps[steps.length - 1];
    if (last?.approver_type !== 'board_member') {
      throw new Error('The last workflow step must be a board member sign-off');
    }
    // The named board member is now mandatory at template-define time
    // — no "any board member" fallback for inquiry records.
    if (!last?.approver_board_member_id) {
      throw new Error('Select a specific board member for the final sign-off');
    }
    return true;
  })
];

router.post('/templates',                 templateValidators, validate, inquiryController.createTemplate);
router.get('/templates',                  [query('status').optional().isIn(['active', 'archived'])], validate, inquiryController.listTemplates);
router.get('/templates/:templateId',      [param('templateId').isMongoId()], validate, inquiryController.getTemplate);
router.put('/templates/:templateId',      [param('templateId').isMongoId(), ...templateValidators], validate, inquiryController.updateTemplate);
router.post('/templates/:templateId/archive', [param('templateId').isMongoId()], validate, inquiryController.archiveTemplate);

/* ---------- Records ---------- */

router.post(
  '/templates/:templateId/records',
  [param('templateId').isMongoId()],
  validate,
  recordUpload.any(),
  handleUploadError,
  inquiryController.createRecord
);

router.get('/records',
  [
    query('templateId').optional().isMongoId(),
    query('status').optional().isIn(['pending', 'approved', 'rejected']),
    query('parentEntityType').optional().isIn(ALLOWED_PARENT_TYPES),
    query('parentEntityId').optional().isMongoId()
  ],
  validate,
  inquiryController.listRecords
);

router.get('/records/:recordId',
  [param('recordId').isMongoId()],
  validate,
  inquiryController.getRecord
);

router.post('/records/:recordId/approve',
  [param('recordId').isMongoId(), body('comments').optional().isString()],
  validate,
  inquiryController.approveStep
);

router.post('/records/:recordId/reject',
  [param('recordId').isMongoId(), body('comments').optional().isString()],
  validate,
  inquiryController.rejectStep
);

router.get('/records/:recordId/documents/:fieldKey',
  [param('recordId').isMongoId(), param('fieldKey').isString().notEmpty()],
  validate,
  inquiryController.getDocumentUrl
);

export default router;
