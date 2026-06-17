/**
 * Weekly Report Controller (#5, #11).
 * Config-driven weekly data-entry reports with full history.
 */
import { getTenantConnection } from '../db/connectionManager.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import weeklyReportSchema from '../db/schemas/platform/weeklyReportSchema.js';
import { WEEKLY_REPORT_CONFIG, WEEKLY_REPORT_TYPES } from '../config/weeklyReportConfig.js';

const getModel = (tenantDb) =>
  tenantDb.models.WeeklyReport || tenantDb.model('WeeklyReport', weeklyReportSchema);

const assertType = (type) => {
  if (!WEEKLY_REPORT_CONFIG[type]) {
    throw new AppError('Unknown weekly report type', 400, 'INVALID_REPORT_TYPE');
  }
};

// Normalize an incoming date to midnight UTC so a week maps to one row.
const normalizeWeek = (raw) => {
  const d = raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) throw new AppError('Valid week_ending is required', 400, 'INVALID_WEEK');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/** GET /platform/weekly-reports/config — all report type definitions. */
export const getWeeklyReportConfig = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { types: WEEKLY_REPORT_TYPES, config: WEEKLY_REPORT_CONFIG } });
});

/** GET /platform/weekly-reports/:type — history (most recent first). */
export const listWeeklyReports = asyncHandler(async (req, res) => {
  const { type } = req.params;
  assertType(type);
  const tenantDb = await getTenantConnection(req.orgId);
  const Model = getModel(tenantDb);
  const rows = await Model.find({ org_id: req.orgId, report_type: type })
    .sort({ week_ending: -1 })
    .populate('updated_by', 'first_name last_name email')
    .lean();
  res.json({ success: true, data: rows });
});

/** GET /platform/weekly-reports/:type/:weekEnding — one week (or null). */
export const getWeeklyReport = asyncHandler(async (req, res) => {
  const { type, weekEnding } = req.params;
  assertType(type);
  const week = normalizeWeek(weekEnding);
  const tenantDb = await getTenantConnection(req.orgId);
  const Model = getModel(tenantDb);
  const row = await Model.findOne({ org_id: req.orgId, report_type: type, week_ending: week }).lean();
  res.json({ success: true, data: row || null });
});

/** PUT /platform/weekly-reports/:type — upsert the report for a week. */
export const upsertWeeklyReport = asyncHandler(async (req, res) => {
  const { type } = req.params;
  assertType(type);
  const week = normalizeWeek(req.body?.week_ending);
  const values = (req.body?.values && typeof req.body.values === 'object') ? req.body.values : {};
  const userId = req.user?.userId || null;
  const tenantDb = await getTenantConnection(req.orgId);
  const Model = getModel(tenantDb);

  const row = await Model.findOneAndUpdate(
    { org_id: req.orgId, report_type: type, week_ending: week },
    {
      $set: { values, updated_by: userId },
      $setOnInsert: { org_id: req.orgId, report_type: type, week_ending: week, created_by: userId }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  res.json({ success: true, data: row, message: 'Weekly report saved.' });
});
