/**
 * Support Ticket Schema (Tenant DB)
 * 
 * Stores support tickets / help center requests
 */

import mongoose from 'mongoose';

const supportTicketSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  ticket_number: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  summary: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
    index: true
  },
  status: {
    type: String,
    enum: ['new', 'in_progress', 'solved', 'declined', 'on_hold'],
    default: 'new',
    index: true
  },
  category: {
    type: String,
    enum: ['technical_error', 'bug_report', 'feature_request', 'access_issue', 'data_issue', 'general', 'other',
           'technical', 'billing', 'account', 'feedback'],
    default: 'general'
  },
  module: {
    type: String,
    enum: [
      'IT Systems Register', 'Risk Register', 'Policy Register',
      'Financial Management', 'Human Resources', 'Meetings & Calendar',
      'Compliance', 'Asset Register', 'Grants & Donors',
      'Board & Governance', 'BCP', 'Expenses', 'Other'
    ],
    trim: true
  },
  // Reporter can be internal user or external (via public link)
  reporter: {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    name: { type: String, trim: true },
    email: { type: String, trim: true },
    is_external: { type: Boolean, default: false },
    country: { type: String, trim: true },
    country_code: { type: String, trim: true, uppercase: true }
  },
  // Assigned to internal user
  assignee: {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    assigned_at: { type: Date }
  },
  // Resolution info
  resolution: {
    notes: { type: String, trim: true },
    resolved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolved_at: { type: Date }
  },
  // Attachments
  attachments: [{
    file_name: { type: String, required: true },
    file_path: { type: String, required: true },
    file_size: { type: Number },
    mime_type: { type: String },
    uploaded_at: { type: Date, default: Date.now }
  }],
  // Comments/replies
  comments: [{
    message: { type: String, required: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    created_by_name: { type: String },
    is_internal: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
  }],
  // Customer satisfaction
  satisfaction_rating: {
    type: Number,
    min: 1,
    max: 5
  },
  satisfaction_feedback: {
    type: String,
    trim: true
  },
  // Timestamps
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  first_response_at: {
    type: Date
  }
}, {
  timestamps: true,
  collection: 'support_tickets'
});

supportTicketSchema.index({ org_id: 1, status: 1 });
supportTicketSchema.index({ org_id: 1, priority: 1 });
supportTicketSchema.index({ org_id: 1, created_at: -1 });
supportTicketSchema.index({ org_id: 1, 'assignee.user_id': 1 });
supportTicketSchema.index({ org_id: 1, 'reporter.country_code': 1 });

supportTicketSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default supportTicketSchema;
