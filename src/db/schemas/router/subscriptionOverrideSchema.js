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
  feature_flags: {
    type: Map,
    of: Boolean,
    default: {}
  },
  pricing: {
    monthlyAUD: { type: Number, default: null },
    annualAUD: { type: Number, default: null },
    overagePerWorkflowAUD: { type: Number, default: null }
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
