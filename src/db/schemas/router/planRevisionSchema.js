/**
 * Plan Revision Schema (Router DB)
 *
 * Immutable history of every change to a SubscriptionPlan. Append-only —
 * the application has no path to update or delete revisions. Used for
 * regulatory audit, billing dispute resolution, and rendering the pricing
 * page exactly as it appeared on the day a customer subscribed.
 *
 * Every save to a Plan creates one new revision row. The `snapshot` field
 * holds the full Plan body at write time; `diff` holds a compact
 * description of what changed against the previous revision.
 */

import mongoose from 'mongoose';

const planRevisionSchema = new mongoose.Schema({
  plan_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true,
    index: true
  },
  plan_code: {
    type: String,
    required: true,
    index: true,
    lowercase: true
  },
  revision_number: {
    type: Number,
    required: true
  },
  snapshot: {
    // Full Plan body — flexible shape so future Plan additions don't break
    // historical revisions.
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  diff: [{
    path: { type: String },
    from: { type: mongoose.Schema.Types.Mixed },
    to: { type: mongoose.Schema.Types.Mixed }
  }],
  reason: {
    type: String,
    default: '',
    trim: true
  },
  changed_by: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  changed_at: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  // No timestamps — revisions are append-only and we own the time field.
  collection: 'plan_revisions'
});

planRevisionSchema.index({ plan_id: 1, revision_number: -1 }, { unique: true });

export default planRevisionSchema;
