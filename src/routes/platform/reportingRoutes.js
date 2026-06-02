/**
 * Reporting & Compliance routes: AIS + ACNC annual financial report
 */

import express from 'express';
import { query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { validate } from '../../middleware/validation.js';
import {
  getAisPrefill,
  getAcncFinancialPrefill,
  downloadAisPdf,
  downloadAisDocx,
  downloadAcncFinancialPdf,
  downloadAcncFinancialDocx,
  getExpensesBySupplierReport,
  getExpensesByProjectReport
} from '../../controllers/reportingController.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('governance.compliance_checklist'));
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

/* --------- Spend analysis: by supplier / by project --------- */

// Common optional filter validators used by both pivots. Status enum
// mirrors the expense schema; sending an unknown status is treated as
// "no status filter" by the service rather than rejected here.
const spendAnalysisFilterValidators = [
  query('startDate').optional().isISO8601().withMessage('startDate must be ISO 8601'),
  query('endDate').optional().isISO8601().withMessage('endDate must be ISO 8601'),
  query('status').optional().isString()
];

router.get(
  '/expenses/by-supplier',
  spendAnalysisFilterValidators,
  validate,
  getExpensesBySupplierReport
);

router.get(
  '/expenses/by-project',
  spendAnalysisFilterValidators,
  validate,
  getExpensesByProjectReport
);

export default router;

