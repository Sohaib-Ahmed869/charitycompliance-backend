/**
 * BillingEvent (Router DB) — append-only audit log of every pricing or
 * billing-relevant write performed in the SuperAdmin portal.
 *
 * Mirrors handbook §14.2. Anything a Calcite operator does that affects
 * money or product configuration writes a row here. Read by /admin/audit.
 */

import mongoose from 'mongoose';

const ACTION_CODES = [
  'plan.created',
  'plan.updated',
  'plan.archived',
  'plan.materialised',
  'subscription.assigned',
  'subscription.changed',
  'subscription.paused',
  'subscription.cancelled',
  'subscription_override.created',
  'subscription_override.updated',
  'subscription_override.cleared',
  'coupon.created',
  'coupon.archived',
  'feature_flag.created',
  'feature_flag.updated',
  'feature_flag.deprecated',
  'system.kill_switch_engaged',
  'system.kill_switch_released',
  'super_admin.created',
  'super_admin.password_rotated'
];

const billingEventSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    enum: ACTION_CODES,
    index: true
  },
  // Subject of the action — tenantId / plan code / coupon code / etc.
  target_type: { type: String, default: '', index: true },
  target_id: { type: String, default: '', index: true },
  target_label: { type: String, default: '' },

  // Per-tenant filter (when applicable) so we can scope the audit screen.
  tenant_id: { type: String, default: '', index: true },

  // Who did it.
  actor_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  actor_email: { type: String, default: '' },

  // What changed — flat list of {path, from, to}.
  diff: { type: mongoose.Schema.Types.Mixed, default: [] },
  reason: { type: String, default: '', trim: true },

  // Free-form additional payload (e.g. coupon code applied, override id).
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Two-person approval (handbook §7.3) — flagged actions land in
  // 'pending_approval'; a second super-admin flips them to 'executed'.
  status: {
    type: String,
    enum: ['executed', 'pending_approval', 'rejected'],
    default: 'executed',
    index: true
  },
  approved_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  approved_at: { type: Date, default: null },

  created_at: { type: Date, default: Date.now, index: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'billing_events'
});

billingEventSchema.index({ created_at: -1 });
billingEventSchema.index({ tenant_id: 1, created_at: -1 });

export default billingEventSchema;
