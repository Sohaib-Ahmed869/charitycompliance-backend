/**
 * Usage meter — counts workflow runs and seat counts per tenant.
 *
 * Stored in each tenant's own DB (collection `usage_counters`) keyed by
 * (period_start, metric). Workflows roll over each calendar month — when
 * the current period_end < now, the next increment opens a new period.
 *
 * Two public functions:
 *   incrementWorkflow({ tenantDb, orgId })  — bump current period counter
 *   getUsageSummary({ tenantDb, orgId })    — read counters + seat totals
 *
 * Seat counts (staff/board) are derived live from the tenant's User /
 * BoardMember collections — no counter needed; querying counts is cheap.
 */

import mongoose from 'mongoose';

const usageCounterSchema = new mongoose.Schema({
  organization_id: { type: String, required: true, index: true },
  period_start:    { type: Date,   required: true, index: true },
  period_end:      { type: Date,   required: true },
  metric:          { type: String, required: true, index: true },
  count:           { type: Number, default: 0 },
  updated_at:      { type: Date,   default: Date.now }
}, { collection: 'usage_counters' });
usageCounterSchema.index({ organization_id: 1, metric: 1, period_start: -1 });

function getModel(tenantDb) {
  return tenantDb.models.UsageCounter || tenantDb.model('UsageCounter', usageCounterSchema);
}

function currentPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { period_start: start, period_end: end };
}

function currentDay() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { period_start: start, period_end: end };
}

// Sentinel "lifetime" period for cumulative metrics like storageGB.
const LIFETIME_PERIOD = {
  period_start: new Date('2000-01-01T00:00:00.000Z'),
  period_end:   new Date('2099-12-31T00:00:00.000Z')
};

/**
 * Bump the workflows counter for the current calendar month. Creates the
 * row on first call. Returns the new count so the caller (enforceLimit)
 * can decide whether to set X-Usage-Warning or block.
 */
export async function incrementWorkflow({ tenantDb, orgId }) {
  if (!tenantDb || !orgId) return null;
  const Counter = getModel(tenantDb);
  const { period_start, period_end } = currentPeriod();
  const updated = await Counter.findOneAndUpdate(
    { organization_id: orgId, metric: 'workflowsPerMonth', period_start },
    {
      $inc: { count: 1 },
      $setOnInsert: { period_end },
      $set: { updated_at: new Date() }
    },
    { upsert: true, new: true }
  ).lean();
  return updated.count;
}

/** Read the current period count for a single metric (without incrementing). */
export async function getCurrentCount({ tenantDb, orgId, metric }) {
  if (!tenantDb || !orgId) return 0;
  const Counter = getModel(tenantDb);
  const { period_start } = currentPeriod();
  const doc = await Counter
    .findOne({ organization_id: orgId, metric, period_start })
    .lean();
  return doc?.count || 0;
}

/** Bump the API-calls counter for the current calendar day. */
export async function incrementApiCall({ tenantDb, orgId }) {
  if (!tenantDb || !orgId) return null;
  const Counter = getModel(tenantDb);
  const { period_start, period_end } = currentDay();
  const updated = await Counter.findOneAndUpdate(
    { organization_id: orgId, metric: 'apiCallsPerDay', period_start },
    {
      $inc: { count: 1 },
      $setOnInsert: { period_end },
      $set: { updated_at: new Date() }
    },
    { upsert: true, new: true }
  ).lean();
  return updated.count;
}

/** Read today's API call count. */
export async function getApiCallsToday({ tenantDb, orgId }) {
  if (!tenantDb || !orgId) return 0;
  const Counter = getModel(tenantDb);
  const { period_start } = currentDay();
  const doc = await Counter
    .findOne({ organization_id: orgId, metric: 'apiCallsPerDay', period_start })
    .lean();
  return doc?.count || 0;
}

/**
 * Cumulative storage tracker — increment on file upload, decrement on
 * delete. Stored as bytes; converted to GB at read time.
 */
export async function adjustStorageBytes({ tenantDb, orgId, deltaBytes }) {
  if (!tenantDb || !orgId || !deltaBytes) return null;
  const Counter = getModel(tenantDb);
  const updated = await Counter.findOneAndUpdate(
    { organization_id: orgId, metric: 'storageBytes', period_start: LIFETIME_PERIOD.period_start },
    {
      $inc: { count: Number(deltaBytes) },
      $setOnInsert: { period_end: LIFETIME_PERIOD.period_end },
      $set: { updated_at: new Date() }
    },
    { upsert: true, new: true }
  ).lean();
  // Never let it go negative (would happen if a delete races with a missed insert).
  if (updated.count < 0) {
    await Counter.updateOne(
      { _id: updated._id },
      { $set: { count: 0 } }
    );
    return 0;
  }
  return updated.count;
}

export async function getStorageBytes({ tenantDb, orgId }) {
  if (!tenantDb || !orgId) return 0;
  const Counter = getModel(tenantDb);
  const doc = await Counter
    .findOne({ organization_id: orgId, metric: 'storageBytes', period_start: LIFETIME_PERIOD.period_start })
    .lean();
  return Math.max(0, doc?.count || 0);
}

/**
 * Aggregate usage summary used by GET /platform/billing/usage. Returns
 * counters + seat totals derived from User / BoardMember collections in
 * the tenant DB. Resilient: missing collections default to 0.
 */
export async function getUsageSummary({ tenantDb, orgId }) {
  const { period_start, period_end } = currentPeriod();
  const workflowsThisPeriod = await getCurrentCount({ tenantDb, orgId, metric: 'workflowsPerMonth' });
  const apiCallsToday = await getApiCallsToday({ tenantDb, orgId });
  const storageBytes = await getStorageBytes({ tenantDb, orgId });
  const storageGBUsed = storageBytes / (1024 * 1024 * 1024);

  let staffSeatsActive = 0;
  let boardSeatsActive = 0;
  try {
    if (tenantDb?.collection) {
      staffSeatsActive = await tenantDb.collection('users').countDocuments({ status: 'active' }).catch(() => 0);
      boardSeatsActive = await tenantDb.collection('board_members').countDocuments({ status: 'active' }).catch(() => 0);
    }
  } catch { /* tenant collections may not exist yet */ }

  return {
    period_start,
    period_end,
    workflowsThisPeriod,
    staffSeatsActive,
    boardSeatsActive,
    storageGBUsed: Math.round(storageGBUsed * 100) / 100,
    apiCallsToday
  };
}
