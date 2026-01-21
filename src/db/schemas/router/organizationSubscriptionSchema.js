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
