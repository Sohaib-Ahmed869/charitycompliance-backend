/**
 * Reporting & Compliance routes: AIS + ACNC annual financial report
 */

import express from 'express';
import { query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validation.js';
import {
  getAisPrefill,
  getAcncFinancialPrefill,
  downloadAisPdf,
  downloadAisDocx,
  downloadAcncFinancialPdf,
  downloadAcncFinancialDocx
} from '../../controllers/reportingController.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requirePermission('module:reporting:view'));

router.get(
  '/ais/prefill',
  [query('fyEnd').notEmpty().withMessage('fyEnd is required')],
  validate,
  getAisPrefill
);

router.post(
  '/ais/pdf',
  [query('fyEnd').notEmpty().withMessage('fyEnd is required')],
  validate,
  downloadAisPdf
);

router.post(
  '/ais/docx',
  [query('fyEnd').notEmpty().withMessage('fyEnd is required')],
  validate,
  downloadAisDocx
);

router.get(
  '/acnc-financial/prefill',
  [query('fyEnd').notEmpty().withMessage('fyEnd is required')],
  validate,
  getAcncFinancialPrefill
);

router.post(
  '/acnc-financial/pdf',
  [query('fyEnd').notEmpty().withMessage('fyEnd is required')],
  validate,
  downloadAcncFinancialPdf
);

router.post(
  '/acnc-financial/docx',
  [query('fyEnd').notEmpty().withMessage('fyEnd is required')],
  validate,
  downloadAcncFinancialDocx
);

export default router;

