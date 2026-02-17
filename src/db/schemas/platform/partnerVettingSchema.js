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
    enum: ['pending', 'approved', 'rejected'],
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
      comments: { type: String, trim: true }
    }
  ],
  documents: [
    {
      name: { type: String, trim: true },
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
