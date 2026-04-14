/**
 * Partner Vetting Schema (Tenant DB)
 *
 * Tracks funding partner due diligence and compliance checks.
 */

import mongoose from 'mongoose';

const partnerVettingSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  organization_name: {
    type: String,
    required: true,
    trim: true
  },
  trading_name: {
    type: String,
    trim: true
  },
  abn_registration_number: {
    type: String,
    trim: true
  },
  country: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true
  },
  website: {
    type: String,
    trim: true
  },
  contact: {
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true }
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'resubmission_required'],
    default: 'pending',
    index: true
  },
  risk_rating: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  review_date: {
    type: Date
  },
  vetting_checks: [
    {
      name: { type: String, trim: true },
      check_type: {
        type: String,
        enum: ['standard', 'other'],
        default: 'standard'
      },
      other_name: { type: String, trim: true },
      status: {
        type: String,
        enum: ['pending', 'completed', 'cleared'],
        default: 'pending'
      },
      ranking: {
        type: String,
        enum: ['low', 'medium', 'high', ''],
        default: ''
      },
      comments: { type: String, trim: true },
      documents: [
        {
          file_path: { type: String },
          file_name: { type: String },
          uploaded_at: { type: Date, default: Date.now }
        }
      ]
    }
  ],
  documents: [
    {
      name: { type: String, trim: true },
      doc_type: {
        type: String,
        enum: ['standard', 'other'],
        default: 'standard'
      },
      other_name: { type: String, trim: true },
      status: {
        type: String,
        enum: ['pending', 'completed'],
        default: 'pending'
      },
      file_path: { type: String },
      file_name: { type: String }
    }
  ],
  risk_assessment: {
    overall_risk_rating: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    },
    review_date: { type: Date },
    notes: { type: String, trim: true }
  },
  /** Data protection / GDPR-style due diligence (partner jurisdiction vs org home is flagged automatically). */
  data_gdpr_compliance: {
    backup_verified: { type: Boolean, default: false },
    storage_location: { type: String, trim: true, default: '' },
    gdpr_confirmed: { type: Boolean, default: false },
    dpa_signed: { type: Boolean, default: false },
    breach_process_confirmed: { type: Boolean, default: false },
    /** Set by application layer from partner country vs organization address_country */
    overseas_partner_auto: { type: Boolean, default: false }
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'partner_vetting'
});

partnerVettingSchema.index({ org_id: 1, status: 1 });
partnerVettingSchema.index({ org_id: 1, review_date: 1 });
partnerVettingSchema.index({ org_id: 1, createdAt: -1 });

export default partnerVettingSchema;
