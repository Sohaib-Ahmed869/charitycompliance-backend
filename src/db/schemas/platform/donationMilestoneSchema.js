/**
 * Donation Milestone Schema (Tenant DB)
 * Milestones attached to funding agreements / donations for acquittals.
 */

import mongoose from 'mongoose';

const donationMilestoneSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  funding_agreement_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FundingAgreement',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  milestone_type: {
    type: String,
    enum: ['reporting', 'payment', 'site_visit', 'other'],
    default: 'reporting'
  },
  amount: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'AUD'
  },
  due_date: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['upcoming', 'completed', 'overdue'],
    default: 'upcoming',
    index: true
  },
  evidence_required: {
    type: String,
    default: ''
  },
  documents: [{
    name: { type: String },
    size: { type: Number },
    file_type: { type: String },
    url: { type: String },
    key: { type: String }
  }],
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'donation_milestones'
});

donationMilestoneSchema.index({ org_id: 1, funding_agreement_id: 1, due_date: 1 });

export default donationMilestoneSchema;

