/**
 * Financial Controls Schema (Tenant DB)
 * 
 * Financial controls, reporting period, and revenue information
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../../../utils/mongooseEncryptPlugin.js';

const financialControlsSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
    unique: true // One financial controls record per organization
  },
  estimated_annual_revenue: {
    type: Number,
    required: true,
    min: 0
  },
  financial_year_end_date: {
    type: Date,
    required: true
  },
  current_revenue_sources: {
    type: String,
    required: true,
    trim: true
  },
  intended_revenue_sources: {
    type: String,
    required: true,
    trim: true
  },
  uses_different_reporting_period: {
    type: String,
    enum: ['yes', 'no'],
    required: true,
    default: 'no'
  },
  reporting_period_start_date: {
    type: Date
  },
  reporting_period_end_date: {
    type: Date
  },
  reason_for_different_period: {
    type: String,
    trim: true
  },
  education_id: {
    type: String,
    trim: true
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
  timestamps: false // We're using custom created_at/updated_at
});

// Indexes
financialControlsSchema.index({ org_id: 1 });

// Apply encryption plugin
financialControlsSchema.plugin(mongooseEncryptPlugin, {
  fields: ['current_revenue_sources', 'intended_revenue_sources', 'reason_for_different_period', 'education_id']
});

// Update updated_at before saving
financialControlsSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default financialControlsSchema;
