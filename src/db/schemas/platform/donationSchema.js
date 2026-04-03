/**
 * Donation Schema (Tenant DB)
 * Simple register of donations, optionally linked to a donor.
 */

import mongoose from 'mongoose';

const donationSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  donor_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Donor',
    required: false
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'AUD'
  },
  category: {
    type: String,
    trim: true
  },
  submitted_at: {
    type: Date
  },
  outcome_due_at: {
    type: Date
  },
  lead_name: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['draft', 'submitted', 'approved', 'resubmission_required'],
    default: 'draft',
    index: true
  },
  donor_snapshot: {
    type: mongoose.Schema.Types.Mixed
  },
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  }
}, {
  timestamps: true,
  collection: 'donations'
});

donationSchema.index({ org_id: 1, status: 1 });

export default donationSchema;

