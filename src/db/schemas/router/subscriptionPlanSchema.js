/**
 * Subscription Plan Schema (Router DB)
 *
 * Catalogue definition of a subscription tier (Foundation / Professional /
 * Enterprise / custom-<n>). Single source of truth for prices, included
 * quotas, and feature inclusion — nothing in the application may hard-code
 * any of these values.
 *
 * Mirrors handbook §3.2. Legacy top-level fields (plan_code, plan_name,
 * monthly_price, yearly_price, features, is_active) are preserved for
 * backwards compat with any documents already in the Router DB; the
 * canonical fields for new work live under `pricing`, `limits`,
 * `feature_flags`, `support`, `metadata`. Old docs continue to read; new
 * writes populate both old and new fields where they overlap so any
 * legacy reader keeps working.
 */

import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  // ── Legacy / shared identity ───────────────────────────────────────────
  plan_code: {
    // Slug — handbook calls this `code`. Free-form to allow custom-<n>
    // plans created by SuperAdmin without a schema migration.
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
  },
  plan_name: {
    type: String,
    required: true,
    trim: true
  },

  // ── Visibility / lifecycle ─────────────────────────────────────────────
  visibility: {
    type: String,
    enum: ['public', 'private'],
    default: 'public'
  },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true
  },
  // Legacy boolean retained for back-compat with any existing reader.
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },

  // ── Pricing block (handbook §3.2 — pricing) ────────────────────────────
  pricing: {
    monthlyAUD: { type: Number, default: 0, min: 0 },
    annualAUD: { type: Number, default: 0, min: 0 },
    setupFeeMonthlyAUD: { type: Number, default: 0, min: 0 },
    setupFeeAnnualAUD: { type: Number, default: 0, min: 0 },
    overagePerWorkflowAUD: { type: Number, default: null }, // legacy — kept for back-compat with existing tenants
    currency: { type: String, default: 'AUD' },
    stripeProductId: { type: String, default: '' },
    stripeMonthlyPriceId: { type: String, default: '' },
    stripeAnnualPriceId: { type: String, default: '' },
    stripeOverageMeterId: { type: String, default: '' }, // legacy — workflow meter
    // One-time setup fee Price IDs (created in Stripe as one-time prices).
    // Appended as a line_item on Checkout when set.
    stripeSetupMonthlyPriceId: { type: String, default: '' },
    stripeSetupAnnualPriceId: { type: String, default: '' },
    /**
     * Per-metric overage rates. 0 / unset means "no overage available"
     * for that metric — once the tenant hits the limit they're blocked
     * with LIMIT_EXCEEDED. Any positive value means "charge this AUD
     * per extra unit until the tenant's hard_cap_aud is reached, then
     * block." Currently supported metrics:
     *   workflowsPerMonth, apiCallsPerDay, staffSeats, boardSeats, storageGB
     */
    overageRatesAUD: {
      workflowsPerMonth: { type: Number, default: 0, min: 0 },
      apiCallsPerDay:    { type: Number, default: 0, min: 0 },
      staffSeats:        { type: Number, default: 0, min: 0 },
      boardSeats:        { type: Number, default: 0, min: 0 },
      storageGB:         { type: Number, default: 0, min: 0 }
    },
    /**
     * Stripe metered Price IDs, one per metric. Required for the
     * middleware to report usage to Stripe at overage time — without
     * this, exceeding the limit will block instead of charge.
     */
    stripeOverageMeters: {
      workflowsPerMonth: { type: String, default: '' },
      apiCallsPerDay:    { type: String, default: '' },
      staffSeats:        { type: String, default: '' },
      boardSeats:        { type: String, default: '' },
      storageGB:         { type: String, default: '' }
    }
  },

  // ── Limits block (handbook §5.1) ───────────────────────────────────────
  // -1 represents "unlimited" for any field where it makes sense.
  limits: {
    staffSeats: { type: Number, default: 5 },
    boardSeats: { type: Number, default: 9 },
    workflowsPerMonth: { type: Number, default: 50 },
    storageGB: { type: Number, default: 10 },
    apiCallsPerDay: { type: Number, default: 0 },
    customWorkflows: { type: Number, default: 0 },
    childEntities: { type: Number, default: 0 },
    softCapPct: { type: Number, default: 80, min: 0, max: 100 },
    hardCapPct: { type: Number, default: 100, min: 0, max: 200 }
  },

  // ── Feature flag inclusion (object — flag code → boolean) ─────────────
  // Plain object (not Map) because feature flag codes are namespaced with
  // dots ("governance.organisation") and Mongoose Maps reject dotted keys.
  // Resolved against the FeatureFlag catalogue at runtime; missing keys
  // are treated as `false`. Renamed from legacy `features` to surface
  // explicit intent in the dashboard.
  feature_flags: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },

  // ── Support / SLA ──────────────────────────────────────────────────────
  support: {
    channel: {
      type: String,
      enum: ['email', 'priority', 'dedicated-csm'],
      default: 'email'
    },
    responseSLAHours: { type: Number, default: 48 },
    uptimeSLAPct: { type: Number, default: null } // null = no contractual SLA
  },

  trial_days: { type: Number, default: 14, min: 0 },

  // ── Metadata for the customer-facing pricing page ──────────────────────
  metadata: {
    description: { type: String, default: '' },
    targetCustomer: { type: String, default: '' },
    sortOrder: { type: Number, default: 100 }
  },

  // ── Legacy fields kept for back-compat ─────────────────────────────────
  // monthly_price / yearly_price are no longer required because
  // `pricing.monthlyAUD` and `pricing.annualAUD` are canonical now. Existing
  // reader code that still references them will continue to work because
  // the seed populates both (see scripts/seedAdminCatalogue.js).
  monthly_price: { type: Number, default: 0, min: 0 },
  yearly_price: { type: Number, default: 0, min: 0 },
  features: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ── Audit ──────────────────────────────────────────────────────────────
  current_revision: { type: Number, default: 1 },
  updated_by: { type: mongoose.Schema.Types.ObjectId, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'subscription_plans'
});

subscriptionPlanSchema.index({ plan_code: 1 }, { unique: true });
subscriptionPlanSchema.index({ status: 1, visibility: 1 });

export default subscriptionPlanSchema;
