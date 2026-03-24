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
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'rejected', 'lodged'],
    default: 'draft',
    index: true
  },
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
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

export default socialMediaCampaignSchema;

