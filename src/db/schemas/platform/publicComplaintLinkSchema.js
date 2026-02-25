/**
 * Public Complaint Link Schema
 * 
 * Stores public links for complaint submissions
 */

import mongoose from 'mongoose';

const publicComplaintLinkSchema = new mongoose.Schema(
  {
    org_id: {
      type: String,
      required: true,
      index: true,
    },
    link_token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    link_type: {
      type: String,
      enum: ['website_embed', 'public_link', 'qr_code'],
      required: true,
    },
    public_url: {
      type: String,
      required: true,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    expiry_date: {
      type: Date,
    },
    submission_count: {
      type: Number,
      default: 0,
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export default publicComplaintLinkSchema;
