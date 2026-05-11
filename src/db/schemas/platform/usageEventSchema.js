/**
 * UsageEvent — append-only metering events (architecture §2.3).
 *
 * Every workflow that should "count" against a tenant's quota emits one
 * row here at its terminal state (approved / rejected / closed). Rows
 * are idempotent via the unique compound `(org_id, event_id)` index —
 * retries from the calling controller collapse to a single row.
 *
 * The aggregation worker (usageAggregator service) rolls these events
 * into the existing UsageCounter doc every 30s. The hot path
 * (`requireLimitHeadroom` middleware) reads only UsageCounter, not
 * UsageEvent, to keep request latency under the 5ms p95 budget.
 */

import mongoose from 'mongoose';

const usageEventSchema = new mongoose.Schema({
  org_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  // What kind of event — used by the aggregator to bucket counts.
  // e.g. 'expense.approved', 'coi.resolved', 'partner.kyc_passed',
  // 'meeting.minuted', 'training.completed', 'policy.acknowledged'.
  event_code: { type: String, required: true, index: true, trim: true },

  // Idempotency key. Caller supplies a stable id (typically
  // `<entity_collection>:<entity_id>:<terminal_state>`) so retries don't
  // double-count.
  event_id: { type: String, required: true },

  // Counts toward `workflowsThisPeriod`?  Some events are tracked but
  // don't count against the metered quota (e.g. settings changes).
  counts_as_workflow: { type: Boolean, default: true },

  // Optional storage delta in bytes (positive on upload, negative on
  // delete). Aggregator rolls this into `storageBytes`.
  storage_delta_bytes: { type: Number, default: 0 },

  // Free-form payload — handy for ops triage and for re-aggregation if
  // the counter ever needs to be rebuilt from the event log.
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Set by the aggregator the first time this event is rolled in.
  // Re-runs ignore rows where `aggregated_at` is already set.
  aggregated_at: { type: Date, default: null, index: true },

  ts: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false,
  collection: 'usage_events'
});

// Idempotent ingest: same caller emitting the same event_id twice
// upserts a single row.
usageEventSchema.index({ org_id: 1, event_id: 1 }, { unique: true });
usageEventSchema.index({ org_id: 1, ts: -1 });
usageEventSchema.index({ org_id: 1, event_code: 1, ts: -1 });

export default usageEventSchema;
