/**
 * Social Media Campaign Schema (Tenant DB)
 * Campaigns that require approval before publishing/lodging spend.
 */

import mongoose from 'mongoose';

const socialMediaCampaignSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  /** Backwards-compatible primary platform (first in platforms) */
  platform: {
    type: String,
    enum: ['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'flyers', 'other'],
    required: false
  },
  /** Multi-platform support */
  platforms: [{
    type: String,
    enum: ['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'flyers', 'other']
  }],
  /** Backwards-compatible single link (first in post_urls) */
  post_url: {
    type: String,
    trim: true,
    default: ''
  },
  /** Per-platform live links */
  post_urls: [{
    platform: { type: String, enum: ['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'flyers', 'other'], required: true },
    url: { type: String, trim: true, default: '' }
  }],
  objective: {
    type: String,
    trim: true,
    default: ''
  },
  start_date: {
    type: Date,
    default: null
  },
  end_date: {
    type: Date,
    default: null
  },
  estimated_budget: {
    type: Number,
    default: 0,
    min: 0
  },
  ad_spend_estimate: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'AUD'
  },
  images: [{
    name: { type: String },
    size: { type: Number },
    file_type: { type: String },
    url: { type: String },
    key: { type: String }
  }],
  notes: {
    type: String,
    default: ''
  },
  /**
   * pending: awaiting pre-publication approval (content/creative)
   * approved: pre-approved; user must publish with live URL + registered account, then post-compliance workflow runs
   * compliance_pending: live URL logged; awaiting post-publication compliance verification
   * compliance_verified: post-compliance approved
   * published: live URL logged (e.g. after compliance rejection resubmit path); performance metrics may be edited
   * rejected / draft / lodged: legacy or edge cases
   */
  status: {
    type: String,
    enum: [
      'draft', 'pending', 'approved', 'rejected', 'resubmission_required',
      'lodged', 'published', 'compliance_pending', 'compliance_verified',
      // MKT-007/008 — pause is reversible (paused → published / lodged
      // depending on prior state stored in `paused_from_status`).
      // Archive is terminal — campaign is read-only thereafter.
      'paused', 'archived'
    ],
    default: 'draft',
    index: true
  },
  /** When status flips to `paused`, this remembers what it was before
   *  so the resume action can restore it instead of guessing. */
  paused_from_status: { type: String, default: null },
  /** Pre-publication (content) approval */
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  },
  /** Post-publication compliance verification */
  compliance_approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest',
    default: null
  },
  /** Confirmed registered org account/handle the post was published under */
  registered_social_account: {
    type: String,
    trim: true,
    default: ''
  },
  published_at: {
    type: Date,
    default: null
  },
  last_audit_date: {
    type: Date,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'social_media_campaigns'
});

socialMediaCampaignSchema.index({ org_id: 1, createdAt: -1 });
socialMediaCampaignSchema.index({ org_id: 1, platform: 1 });
socialMediaCampaignSchema.index({ org_id: 1, platforms: 1 });
socialMediaCampaignSchema.index({ org_id: 1, last_audit_date: -1 });

export default socialMediaCampaignSchema;

