/**
 * Organization Subscription Schema (Router DB)
 * 
 * Tracks which subscription plan each organization is on
 */

import mongoose from 'mongoose';

const organizationSubscriptionSchema = new mongoose.Schema({
  organization_id: {
    type: String,
    required: true,
    index: true,
    trim: true,
    lowercase: true
  },
  plan_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  // Pin the exact PlanRevision the tenant is bound to. SuperAdmin price
  // edits write a new revision but DO NOT touch any pinned subscription
  // unless the operator explicitly migrates them. See migrateRevision().
  plan_revision_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlanRevision',
    default: null,
    index: true
  },
  plan_revision_number: {
    type: Number,
    default: null
  },
  billing_cycle: {
    type: String,
    enum: ['monthly', 'yearly'],
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'past_due', 'cancelled', 'trialing', 'incomplete'],
    default: 'active',
    index: true
  },
  stripe_customer_id: {
    type: String,
    index: true,
    sparse: true
  },
  stripe_subscription_id: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  current_period_start: {
    type: Date,
    required: true
  },
  current_period_end: {
    type: Date,
    required: true,
    index: true
  },
  cancel_at_period_end: {
    type: Boolean,
    default: false
  },
  cancelled_at: {
    type: Date
  },
  // SuperAdmin "comped" subscriptions get full access without paying
  // (free trials, partner deals, internal accounts). Set explicitly via
  // /admin/tenants/:orgId/comp endpoint — tracks who/why for audit.
  is_comp: {
    type: Boolean,
    default: false
  },
  comp_reason: { type: String, default: '' },
  comp_granted_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  comp_granted_at: { type: Date, default: null },
  // Stores the ISO of `current_period_end` we last sent a trial-ending
  // reminder for. Lets the scheduler stay idempotent across runs.
  trial_reminder_sent_for: { type: String, default: '' },
  /**
   * Self-serve overage cap (handbook §3.4 / arch §11). Tenant says
   * "never bill me more than $X in overages this month". `enforceLimit`
   * checks this before allowing usage past the included quota; once hit,
   * the request returns 402 LIMIT_EXCEEDED.
   *
   * null = no self-cap (only the global hardCapPct on the plan applies).
   */
  hard_cap_aud: { type: Number, default: null, min: 0 },
  /**
   * Claude/Cursor-style overage tracking. Sum of overage AUD already
   * settled for the current billing period — incremented when the
   * tenant pays an outstanding overage charge via "Pay now", and reset
   * to 0 at every period rollover.
   *
   * The "outstanding overage" surfaced to the tenant is:
   *   sum(per-metric overage spend) - current_period_overage_paid_aud
   *
   * If that value is > 0, we refuse hard-cap edits (handbook §3.4) so
   * the tenant can't dodge a bill by lowering the cap. They either pay
   * the outstanding amount or wait for the next invoice to clear it.
   */
  current_period_overage_paid_aud: { type: Number, default: 0, min: 0 },
  /**
   * Stripe id of the latest one-off invoice we created to bill in-period
   * overage. Stored so /pay-overage-now is idempotent — clicking twice
   * in quick succession returns the same invoice instead of double-
   * charging.
   */
  current_period_overage_invoice_id: { type: String, default: '' },
  /**
   * One-shot flag — set true after we issue the first-overage credit
   * note for this tenant (handbook §5.2). Stops repeat credits on
   * subsequent overage cycles.
   */
  first_overage_credited: { type: Boolean, default: false },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'organization_subscription'
});

organizationSubscriptionSchema.index({ organization_id: 1 });
organizationSubscriptionSchema.index({ stripe_subscription_id: 1 }, { unique: true, sparse: true });
organizationSubscriptionSchema.index({ status: 1 });
organizationSubscriptionSchema.index({ current_period_end: 1 });

export default organizationSubscriptionSchema;
