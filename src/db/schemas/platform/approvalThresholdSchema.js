/**
 * Approval Threshold Schema (Tenant DB)
 * 
 * Defines monetary thresholds for financial approval workflows
 */

import mongoose from 'mongoose';

const thresholdTierSchema = new mongoose.Schema({
  name: {
    type: String,
    enum: ['petty_cash', 'low_cash', 'moderate_cash', 'high_cash'],
    required: true
  },
  min_amount: {
    type: Number,
    required: true,
    min: 0
  },
  max_amount: {
    type: Number,
    required: false, // null means unlimited for high_cash
    min: 0
  }
}, { _id: false });

const approvalThresholdSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
    unique: true
  },
  currency: {
    type: String,
    default: 'USD',
    required: true
  },
  tiers: {
    type: [thresholdTierSchema],
    required: true,
    default: [
      { name: 'petty_cash', min_amount: 0, max_amount: 100 },
      { name: 'low_cash', min_amount: 101, max_amount: 500 },
      { name: 'moderate_cash', min_amount: 501, max_amount: 2000 },
      { name: 'high_cash', min_amount: 2001, max_amount: null }
    ]
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: false,
  collection: 'approval_thresholds'
});

// Validate that tiers don't overlap and are in sequence
approvalThresholdSchema.pre('save', function(next) {
  const tiers = this.tiers.sort((a, b) => a.min_amount - b.min_amount);
  
  for (let i = 0; i < tiers.length - 1; i++) {
    const current = tiers[i];
    const next = tiers[i + 1];
    
    if (current.max_amount !== null && current.max_amount >= next.min_amount) {
      return next(new Error('Threshold tiers cannot overlap'));
    }
    
    if (current.max_amount !== null && current.max_amount + 1 !== next.min_amount) {
      return next(new Error('Threshold tiers must be continuous'));
    }
  }
  
  this.updated_at = new Date();
  next();
});

approvalThresholdSchema.index({ org_id: 1 });

export default approvalThresholdSchema;
