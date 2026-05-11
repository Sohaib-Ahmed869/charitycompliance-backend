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
  'subscription.revision_migrated',
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
  'super_admin.password_rotated',
  'support.session_started',
  'support.session_ended',
  // Two-person approval (deferred-execution requests). The "_pending"
  // event is written when the action is requested; a separate "executed"
  // BillingEvent (the original action code) is written on Approve.
  'plan.update_pending',
  'plan.archive_pending',
  'feature_flag.deprecate_pending',
  // Invoice-level billing-ops actions (Phase C).
  'invoice.credit_issued',
  'invoice.voided',
  'invoice.payment_retried',
  'invoice.bulk_retry_run',
  // Coupon-on-subscription (Phase D).
  'coupon.applied',
  'coupon.removed',
  // Subscription lifecycle (handbook §3.1, §3.2, §5.9)
  'subscription.resumed',
  'subscription_override.expired',
  'invoice.first_overage_credit',
  'subscription.trial_extended',
  'subscription.hard_cap_set',
  'plan.synced_to_stripe',
  // Promo program flows (§3.1)
  'promo.community_impact_applied',
  'promo.founding_customer_applied',
  'promo.volume_group_applied'
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
  approved_by_email: { type: String, default: '' },
  approved_at: { type: Date, default: null },
  rejected_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  rejected_by_email: { type: String, default: '' },
  rejected_at: { type: Date, default: null },
  rejection_reason: { type: String, default: '' },

  // For pending_approval rows — the full payload to replay when a second
  // super-admin approves (e.g. the proposed plan body, archive args, etc).
  pending_payload: { type: mongoose.Schema.Types.Mixed, default: null },
  // Surfaced to the approval-queue UI so the second super-admin sees
  // exactly which dangerous changes triggered the gate (price_raised,
  // quota_reduced, feature_removed, plan_archive, flag_deprecate).
  pending_dangers: { type: [String], default: [] },

  created_at: { type: Date, default: Date.now, index: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'billing_events'
});

billingEventSchema.index({ created_at: -1 });
billingEventSchema.index({ tenant_id: 1, created_at: -1 });
billingEventSchema.index({ status: 1, created_at: -1 });

export default billingEventSchema;
