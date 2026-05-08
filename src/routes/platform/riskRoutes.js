/**
 * Risk Routes
 *
 * API routes for risk management
 */

import express from 'express';
import * as riskController from '../../controllers/riskController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { uploadPolicySingle, handlePolicyUploadError } from '../../middleware/upload.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('governance.risk_register'));

router.get('/counts', riskController.getRiskCounts);

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Risk title is required'),
    body('category').trim().notEmpty().withMessage('Category is required'),
    body('risk_owner_board_member_id').optional().isMongoId().withMessage('Invalid risk owner'),
    body('likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Likelihood must be 1-5'),
    body('consequence').optional().isInt({ min: 1, max: 5 }).withMessage('Consequence must be 1-5')
  ],
  validate,
  riskController.createRisk
);

router.get(
  '/',
  [
    query('status').optional().isIn(['draft', 'pending', 'under_treatment', 'approved', 'resolved', 'rejected', 'closed']),
    query('category').optional().trim(),
    query('search').optional().trim()
  ],
  validate,
  riskController.getRisks
);

router.get(
  '/export/pdf',
  [
    query('status').optional().isIn(['draft', 'pending', 'under_treatment', 'approved', 'resolved', 'rejected', 'closed']),
    query('category').optional().trim(),
    query('search').optional().trim()
  ],
  validate,
  riskController.exportRiskRegisterPdf
);

router.get(
  '/:riskId',
  [param('riskId').isMongoId().withMessage('Invalid risk ID')],
  validate,
  riskController.getRiskById
);

router.get(
  '/:riskId/pdf',
  [param('riskId').isMongoId().withMessage('Invalid risk ID')],
  validate,
  riskController.exportRiskPdf
);

router.put(
  '/:riskId',
  [
    param('riskId').isMongoId().withMessage('Invalid risk ID'),
    body('title').optional().trim().notEmpty(),
    body('category').optional().trim().notEmpty(),
    body('risk_owner_board_member_id').optional().isMongoId().withMessage('Invalid risk owner'),
    body('likelihood').optional().isInt({ min: 1, max: 5 }),
    body('consequence').optional().isInt({ min: 1, max: 5 })
  ],
  validate,
  riskController.updateRisk
);

router.delete(
  '/:riskId',
  [param('riskId').isMongoId().withMessage('Invalid risk ID')],
  validate,
  riskController.deleteRisk
);

router.post(
  '/:riskId/treatments',
  [
    param('riskId').isMongoId().withMessage('Invalid risk ID'),
    body('control_action').optional().trim(),
    body('owner').optional().trim(),
    body('due_date').optional().trim()
  ],
  validate,
  riskController.addTreatment
);

router.post(
  '/:riskId/treatments/:treatmentIndex/evidence',
  [
    param('riskId').isMongoId().withMessage('Invalid risk ID'),
    param('treatmentIndex').isInt({ min: 0 }).withMessage('Invalid treatment index')
  ],
  validate,
  uploadPolicySingle,
  handlePolicyUploadError,
  riskController.addTreatmentEvidence
);

router.post(
  '/:riskId/attachments',
  [param('riskId').isMongoId().withMessage('Invalid risk ID')],
  validate,
  uploadPolicySingle,
  handlePolicyUploadError,
  riskController.addRiskAttachment
);

router.get(
  '/:riskId/attachments/:attachmentIndex/stream',
  [
    param('riskId').isMongoId().withMessage('Invalid risk ID'),
    param('attachmentIndex').isInt({ min: 0 }).withMessage('Invalid attachment index')
  ],
  validate,
  riskController.streamRiskAttachment
);

router.get(
  '/:riskId/treatments/:treatmentIndex/evidence/:evidenceIndex/stream',
  [
    param('riskId').isMongoId().withMessage('Invalid risk ID'),
    param('treatmentIndex').isInt({ min: 0 }).withMessage('Invalid treatment index'),
    param('evidenceIndex').isInt({ min: 0 }).withMessage('Invalid evidence index')
  ],
  validate,
  riskController.streamEvidence
);

export default router;
