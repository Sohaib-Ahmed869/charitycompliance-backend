/**
 * Activity Schema (Tenant DB)
 * 
 * Operating activities, programs, and grants for an organization
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../../../utils/mongooseEncryptPlugin.js';

const activitySchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  link_to_charitable_purpose: {
    type: String,
    required: true,
    trim: true
  },
  beneficiary_group: {
    type: String,
    required: true,
    trim: true
  },
  beneficiary_selection_criteria: {
    type: String,
    required: true,
    trim: true
  },
  estimated_time_allocation: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  estimated_money_allocation: {
    type: Number,
    required: true,
    min: 0
  },
  operating_locations: {
    type: [String],
    required: true,
    default: []
  },
  overseas_details: {
    type: String,
    trim: true
  },
  start_date: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'completed'],
    default: 'active'
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
activitySchema.index({ org_id: 1, status: 1 });
activitySchema.index({ org_id: 1, created_at: -1 });

// Apply encryption plugin
activitySchema.plugin(mongooseEncryptPlugin, {
  fields: ['description', 'link_to_charitable_purpose', 'beneficiary_selection_criteria', 'overseas_details']
});

// Update updated_at before saving
activitySchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default activitySchema;
