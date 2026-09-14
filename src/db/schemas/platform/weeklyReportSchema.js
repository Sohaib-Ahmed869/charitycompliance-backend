/**
 * Weekly Report Schema (Tenant DB) — #5 / #11.
 * One row per (report_type, week_ending). `values` holds field key → value.
 */
import mongoose from 'mongoose';

const weeklyReportSchema = new mongoose.Schema({
  org_id: { type: String, index: true },                 // tenant slug
  report_type: { type: String, required: true, index: true },
  week_ending: { type: Date, required: true, index: true },
  values: { type: mongoose.Schema.Types.Mixed, default: {} },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
  timestamps: true,
  collection: 'weekly_reports'
});

weeklyReportSchema.index({ org_id: 1, report_type: 1, week_ending: 1 }, { unique: true });

export default weeklyReportSchema;
