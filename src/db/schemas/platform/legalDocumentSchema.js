/**
 * Legal Document Schema (Tenant DB)
 * 
 * Organization legal documents with versioning support
 */

import mongoose from 'mongoose';

const versionSchema = new mongoose.Schema({
  version_number: {
    type: Number,
    required: true
  },
  file_key: {
    type: String,
    required: true
  },
  file_name: {
    type: String,
    required: true
  },
  file_size: {
    type: Number
  },
  file_type: {
    type: String
  },
  uploaded_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  uploaded_at: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const legalDocumentSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  document_name: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    enum: ['mou', 'sponsorship_agreement', 'contract', 'lease_agreement', 'grant_agreement', 'sla', 'ambassadors_insurance', 'other'],
    required: true,
    index: true
  },
  category_other_text: {
    type: String,
    trim: true
  },
  effective_date: {
    type: Date
  },
  expiry_date: {
    type: Date
  },
  review_date: {
    type: Date
  },
  contract_details: {
    subtype: {
      type: String,
      enum: ['public_liability', 'professional_indemnity', 'd_and_o', 'workers_comp', 'property', 'cyber', 'volunteer'],
      default: null
    },
    provider: { type: String, trim: true, default: '' },
    policy_number: { type: String, trim: true, default: '' },
    coverage_details: { type: String, trim: true, default: '' },
    premium_amount: { type: Number, default: null },
    renewal_frequency: { type: String, trim: true, default: '' },
    renewal_notes: { type: String, trim: true, default: '' }
  },
  owner_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'archived'],
    default: 'active',
    index: true
  },
  last_reviewed: {
    type: Date
  },
  versions: [versionSchema],
  current_version: {
    type: Number,
    default: 1
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  collection: 'legal_documents'
});

legalDocumentSchema.index({ org_id: 1, status: 1 });
legalDocumentSchema.index({ org_id: 1, category: 1 });
legalDocumentSchema.index({ org_id: 1, category: 1, 'contract_details.subtype': 1 });
legalDocumentSchema.index({ org_id: 1, created_at: -1 });

export default legalDocumentSchema;
