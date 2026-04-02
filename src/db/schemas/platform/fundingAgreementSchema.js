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
  partner_email: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
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
  // Partner must review this PDF before signing (shown in the public sign page).
  // Stored as data-URL to reuse the existing in-app PDF viewer without adding new storage endpoints.
  agreement_attachment_data_url: {
    type: String,
    default: ''
  },
  agreement_attachment_file_name: {
    type: String,
    default: ''
  },
  agreement_attachment_mime_type: {
    type: String,
    default: 'application/pdf'
  },
  internal_signature: {
    signed_at: { type: Date, default: null },
    signed_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    signer_name: { type: String, default: '' },
    signature_data: { type: String, default: '' }, // data URL from DigitalSignature
    notes: { type: String, default: '' }
  },
  partner_signature: {
    signed_at: { type: Date, default: null },
    signer_name: { type: String, default: '' },
    signer_email: { type: String, default: '' },
    signature_data: { type: String, default: '' } // data URL from DigitalSignature
  },
  partner_sign_token: {
    type: String,
    default: null,
    index: true
  },
  partner_sign_token_expires_at: {
    type: Date,
    default: null
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
