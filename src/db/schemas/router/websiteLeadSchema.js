/**
 * Website Lead Schema (Router DB)
 * 
 * Marketing leads captured from website
 */

import mongoose from 'mongoose';

const websiteLeadSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  phone: {
    type: String,
    trim: true
  },
  organization_name: {
    type: String,
    trim: true
  },
  lead_type: {
    type: String,
    enum: ['demo_request', 'contact', 'pricing', 'trial'],
    default: 'contact',
    index: true
  },
  message: {
    type: String
  },
  captured_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  is_converted: {
    type: Boolean,
    default: false,
    index: true
  },
  converted_at: {
    type: Date
  },
  converted_to_org_id: {
    type: String,
    trim: true,
    lowercase: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'website_leads'
});

websiteLeadSchema.index({ email: 1 });
websiteLeadSchema.index({ captured_at: -1 });
websiteLeadSchema.index({ is_converted: 1 });
websiteLeadSchema.index({ lead_type: 1 });

export default websiteLeadSchema;
