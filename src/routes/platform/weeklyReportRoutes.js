/**
 * Weekly Report Routes (#5, #11) — /platform/weekly-reports
 */
import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as ctrl from '../../controllers/weeklyReportController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/config', ctrl.getWeeklyReportConfig);
router.get('/:type', ctrl.listWeeklyReports);
router.get('/:type/:weekEnding', ctrl.getWeeklyReport);
router.put('/:type', ctrl.upsertWeeklyReport);

export default router;
