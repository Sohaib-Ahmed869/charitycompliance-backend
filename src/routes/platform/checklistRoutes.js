/**
 * Checklist Routes
 */

import express from 'express';
import * as checklistController from '../../controllers/checklistController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

router.use(authAndResolveTenant);

// Upload evidence
router.post('/upload', uploadSingle, handleUploadError, checklistController.uploadEvidence);
router.get('/file-url', checklistController.getEvidenceFileUrl);

// Templates
router.get('/templates', checklistController.listTemplates);
router.post('/templates/bootstrap-module-catalog', checklistController.bootstrapModuleCatalogTemplates);
router.post(
  '/templates',
  [
    body('name').trim().notEmpty().withMessage('name is required'),
    body('type').trim().notEmpty().withMessage('type is required'),
    body('items').optional().isArray().withMessage('items must be an array')
  ],
  validate,
  checklistController.createTemplate
);
router.patch(
  '/templates/:templateId',
  [param('templateId').isMongoId().withMessage('Invalid template ID')],
  validate,
  checklistController.updateTemplate
);
router.delete(
  '/templates/:templateId',
  [param('templateId').isMongoId().withMessage('Invalid template ID')],
  validate,
  checklistController.deleteTemplate
);

// Instances
router.get('/instances', checklistController.listInstances);
router.post(
  '/instances',
  [
    body('type').isIn(['month_end', 'quarter_end', 'year_end', 'module']).withMessage('Invalid type'),
    body('year').isInt({ min: 2000, max: 2100 }).withMessage('year is required'),
    body('month').optional().isInt({ min: 1, max: 12 }).withMessage('Invalid month'),
    body('quarter').optional().isInt({ min: 1, max: 4 }).withMessage('Invalid quarter')
  ],
  validate,
  checklistController.createInstance
);
router.post(
  '/instances/resolve-workflow',
  [
    body('entityType').trim().notEmpty().withMessage('entityType is required'),
    body('entityId').trim().notEmpty().withMessage('entityId is required'),
    body('approvalRequestId').optional().isMongoId().withMessage('Invalid approvalRequestId')
  ],
  validate,
  checklistController.resolveWorkflowInstance
);
router.get(
  '/instances/:instanceId',
  [param('instanceId').isMongoId().withMessage('Invalid instance ID')],
  validate,
  checklistController.getInstance
);
router.patch(
  '/instances/:instanceId/items/:itemId',
  [
    param('instanceId').isMongoId().withMessage('Invalid instance ID'),
    param('itemId').isMongoId().withMessage('Invalid item ID'),
    body('checked').optional().isBoolean().withMessage('checked must be boolean'),
    body('notes').optional().isString().withMessage('notes must be string'),
    body('state').optional().isIn(['pending', 'satisfied', 'failed', 'skipped']).withMessage('Invalid state'),
    body('addEvidence').optional()
  ],
  validate,
  checklistController.patchInstanceItem
);
router.post(
  '/instances/:instanceId/close',
  [param('instanceId').isMongoId().withMessage('Invalid instance ID')],
  validate,
  checklistController.closeInstance
);

// Dashboard helpers
router.get('/overdue', checklistController.getOverdueSummary);

// Finance summary for workflow detail pages
router.get(
  '/finance-summary',
  [
    query('type').isIn(['month_end', 'quarter_end']).withMessage('type required'),
    query('year').isInt({ min: 2000, max: 2100 }).withMessage('year required'),
    query('month').optional().isInt({ min: 1, max: 12 }),
    query('quarter').optional().isInt({ min: 1, max: 4 })
  ],
  validate,
  checklistController.getFinanceSummary
);

export default router;

