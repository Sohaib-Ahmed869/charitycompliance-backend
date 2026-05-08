/**
 * SubscriptionOverride (Router DB) — per-tenant deviation from the plan
 * default. The universal escape hatch (handbook §3.6).
 *
 * "Acme is on Foundation but they need 100 GB of storage and the COI
 *  module" → SuperAdmin opens the tenant detail page, fills in this
 *  override, saves. Customer's effective entitlements merge plan +
 *  override at request time, with the override winning field-by-field.
 *
 * One active override per tenant. Editing replaces the existing record;
 * the prior state is captured in BillingEvent.diff for audit.
 */

import mongoose from 'mongoose';

const subscriptionOverrideSchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
  },
  // Optional sub-doc copies of the override fields. Only populated keys
  // override the plan default; everything else falls through.
  limits: {
    staffSeats: { type: Number, default: null },
    boardSeats: { type: Number, default: null },
    workflowsPerMonth: { type: Number, default: null },
    storageGB: { type: Number, default: null },
    apiCallsPerDay: { type: Number, default: null },
    customWorkflows: { type: Number, default: null },
    childEntities: { type: Number, default: null }
  },
  // Plain object (not Map) — feature flag codes contain dots
  // ("governance.organisation"), and Mongoose Maps reject dotted keys.
  // Resolver handles both shapes, but new writes use plain objects.
  feature_flags: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },
  /**
   * How feature_flags is interpreted by the resolver:
   *   'merge'   — override entries are deltas; anything not listed
   *               inherits from the plan default. (default)
   *   'replace' — override.feature_flags is the COMPLETE allowed set;
   *               anything not explicitly set to true here is denied,
   *               regardless of the plan's defaults.
   *
   * Use 'replace' to lock a tenant down to a specific feature subset
   * regardless of the plan they're on. Useful for compliance reasons
   * or contractual feature scoping.
   */
  feature_flag_mode: {
    type: String,
    enum: ['merge', 'replace'],
    default: 'merge'
  },
  pricing: {
    monthlyAUD: { type: Number, default: null },
    annualAUD: { type: Number, default: null },
    overagePerWorkflowAUD: { type: Number, default: null },
    // Tenant-specific Stripe Price IDs — created in Stripe dashboard
    // for this org and linked here. When set, "Apply to Stripe" swaps
    // their subscription to bill the override amount.
    stripeMonthlyPriceId: { type: String, default: '' },
    stripeAnnualPriceId: { type: String, default: '' }
  },

  effective_from: { type: Date, default: Date.now },
  effective_until: { type: Date, default: null }, // null = no expiry
  reason: { type: String, default: '', trim: true },

  approved_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  approved_at: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'subscription_overrides'
});

export default subscriptionOverrideSchema;
