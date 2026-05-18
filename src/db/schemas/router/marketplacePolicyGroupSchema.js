/**
 * MarketplacePolicyGroup (Router DB) — folder for policy templates the
 * SuperAdmin offers in the cross-tenant Policy Marketplace.
 *
 * Lives in the Router DB (shared across all tenants) because the
 * marketplace catalogue is global — every org sees the same list and
 * buys from the same source-of-truth.
 *
 * Slug is auto-derived from the name on create and used in marketplace
 * URLs (/marketplace/group/governance-essentials).
 */

import mongoose from 'mongoose';

const marketplacePolicyGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
  },
  description: {
    type: String,
    default: '',
    trim: true
  },
  // Affects the order rows appear in the marketplace and admin lists.
  // Smaller numbers render first; ties broken by created_at desc.
  sort_order: { type: Number, default: 100 },

  // Soft-archive support — archived groups stay in the DB so their
  // historic policies still resolve, but they're hidden from the
  // tenant marketplace and admin "Active" view.
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true
  },

  // Optional brand-tint hex for the group tile. Falls back to a neutral
  // brand colour in the UI when empty.
  accent_color: { type: String, default: '', trim: true },

  created_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'marketplace_policy_groups'
});

marketplacePolicyGroupSchema.index({ status: 1, sort_order: 1, created_at: -1 });

export default marketplacePolicyGroupSchema;
