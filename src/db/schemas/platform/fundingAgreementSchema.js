/**
 * Funding Agreement Schema (Tenant DB)
 *
 * Records funding agreements for grants and donors.
 */

import mongoose from 'mongoose';

const fundingAgreementSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  agreement_title: {
    type: String,
    required: true,
    trim: true
  },
  partner_name: {
    type: String,
    trim: true
  },
  agreement_type: {
    type: String,
    trim: true
  },
  currency: {
    type: String,
    trim: true,
    default: 'AUD'
  },
  total_amount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  start_date: {
    type: Date
  },
  end_date: {
    type: Date
  },
  description: {
    type: String,
    default: ''
  },
  payment_terms: {
    type: String,
    default: ''
  },
  reporting_requirements: {
    type: String,
    default: ''
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'funding_agreements'
});

fundingAgreementSchema.index({ org_id: 1, status: 1 });
fundingAgreementSchema.index({ org_id: 1, createdAt: -1 });

export default fundingAgreementSchema;
