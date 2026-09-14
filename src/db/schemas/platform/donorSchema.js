/**
 * Donor Schema (Tenant DB)
 *
 * Tracks donors / funders for KYC / AML and grant workflows.
 */

import mongoose from 'mongoose';

const donorSchema = new mongoose.Schema({
  // For donors we store the router orgId string (e.g. shahid_afridi_foundation)
  org_id: {
    type: String,
    required: true,
    index: true
  },

  // Basic organisation / donor details
  name: {
    type: String,
    required: true,
    trim: true
  },
  donor_type: {
    type: String,
    enum: ['individual', 'corporate', 'foundation', 'government', 'other'],
    default: 'other'
  },
  abn_acn: {
    type: String,
    trim: true
  },
  dgr_status: {
    type: String,
    enum: ['endorsed', 'not_applicable', 'pending', 'not_endorsed'],
    default: 'not_applicable'
  },
  description: {
    type: String,
    trim: true
  },

  // Primary contact
  primary_contact: {
    name: { type: String, trim: true },
    position: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true }
  },

  // Workflow + KYC / AML status. `archived` is the terminal state for
  // donors that are no longer engaged but kept on file for audit /
  // history. Only reachable from `inactive` (frontend gate enforces).
  status: {
    type: String,
    enum: ['draft', 'pending_approval', 'approved', 'rejected', 'inactive', 'archived'],
    default: 'pending_approval',
    index: true
  },
  approval_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix'
  },
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  },
  approved_for_kyc: {
    type: Boolean,
    default: false,
    index: true
  },

  // KYC / AML state summary
  kyc_status: {
    type: String,
    enum: ['not_started', 'in_progress', 'completed', 'failed'],
    default: 'not_started'
  },
  aml_screening_status: {
    type: String,
    enum: ['not_started', 'screening', 'cleared', 'flagged'],
    default: 'not_started'
  },
  overall_risk_rating: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  last_kyc_review_date: {
    type: Date
  },

  // Donor size and financial context to drive approval thresholds
  size: {
    type: String,
    enum: ['small', 'medium', 'large'],
    default: 'small'
  },
  expected_annual_donation: {
    type: Number,
    default: 0
  },
  // Marks the donor as a VIP — surfaced in the register UI and required by
  // the edit form spec so that the toggle persists through a save round-trip.
  vip: {
    type: Boolean,
    default: false,
    index: true
  },

  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'donors'
});

donorSchema.index({ org_id: 1, status: 1 });
donorSchema.index({ org_id: 1, approved_for_kyc: 1 });

export default donorSchema;

