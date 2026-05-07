/**
 * Coupon (Router DB) — discount codes attached to subscriptions.
 *
 * Locally mirrored from Stripe coupons (we'll write to Stripe in Sprint 5
 * once the Stripe integration lands). For now coupons live entirely in
 * Mongo so the SuperAdmin can model the four discount programs (Annual
 * commit, Community Impact, Founding Customer, Volume) without any
 * external dependency.
 */

import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    uppercase: true
  },
  name: {
    type: String,
    default: '',
    trim: true
  },
  // Either percent_off OR amount_off_aud — not both. Validated in the
  // controller; schema stays permissive so partial drafts can save.
  percent_off: { type: Number, min: 0, max: 100, default: null },
  amount_off_aud: { type: Number, min: 0, default: null },

  duration: {
    type: String,
    enum: ['once', 'repeating', 'forever'],
    default: 'once'
  },
  duration_in_months: { type: Number, min: 1, default: null },

  max_redemptions: { type: Number, min: 1, default: null },
  times_redeemed: { type: Number, default: 0 },
  redeem_by: { type: Date, default: null },

  // Restrict applicability — null/empty means "any plan".
  applies_to_plan_codes: [{ type: String, trim: true, lowercase: true }],

  // Stripe linkage — populated once we wire Stripe integration.
  stripe_coupon_id: { type: String, default: '' },

  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true
  },

  created_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'coupons'
});

couponSchema.index({ status: 1, created_at: -1 });

export default couponSchema;
