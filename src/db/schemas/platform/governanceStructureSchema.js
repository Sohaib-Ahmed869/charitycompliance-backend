/**
 * Governance Structure Schema (Tenant DB)
 * 
 * Governance structure, policies, and compliance information
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../../../utils/mongooseEncryptPlugin.js';

const governanceStructureSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
    unique: true // One governance structure record per organization
  },
  conflict_of_interest_clause: {
    type: String,
    required: true,
    trim: true
  },
  conflict_of_interest_policy_url: {
    type: String,
    trim: true
  },
  conflict_management_explanation: {
    type: String,
    required: true,
    trim: true
  },
  works_with_vulnerable_people: {
    type: String,
    enum: ['yes', 'no'],
    required: true,
    default: 'no'
  },
  safeguarding_details: {
    type: String,
    trim: true
  },
  financial_management_policies_url: {
    type: String,
    trim: true
  },
  financial_governance_explanation: {
    type: String,
    trim: true
  },
  third_party_controls: {
    type: String,
    required: true,
    trim: true
  },
  accountability_explanation: {
    type: String,
    required: true,
    trim: true
  },
  member_concerns_process: {
    type: String,
    required: true,
    trim: true
  },
  is_basic_religious_charity: {
    type: String,
    enum: ['yes', 'no', 'unsure'],
    required: true,
    default: 'no'
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
governanceStructureSchema.index({ org_id: 1 });

// Apply encryption plugin
governanceStructureSchema.plugin(mongooseEncryptPlugin, {
  fields: ['conflict_management_explanation', 'safeguarding_details', 'financial_governance_explanation', 'third_party_controls', 'accountability_explanation', 'member_concerns_process']
});

// Update updated_at before saving
governanceStructureSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default governanceStructureSchema;
