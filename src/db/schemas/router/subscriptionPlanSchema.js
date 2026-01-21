/**
 * Subscription Plan Schema (Router DB)
 * 
 * Available subscription plans with pricing and features
 */

import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  plan_code: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true,
    enum: ['free', 'standard', 'premium', 'enterprise']
  },
  plan_name: {
    type: String,
    required: true,
    trim: true
  },
  monthly_price: {
    type: Number,
    required: true,
    min: 0
  },
  yearly_price: {
    type: Number,
    required: true,
    min: 0
  },
  features: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  is_active: {
    type: Boolean,
    default: true,
    index: true
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
  collection: 'subscription_plans'
});

subscriptionPlanSchema.index({ plan_code: 1 }, { unique: true });
subscriptionPlanSchema.index({ is_active: 1 });

export default subscriptionPlanSchema;
