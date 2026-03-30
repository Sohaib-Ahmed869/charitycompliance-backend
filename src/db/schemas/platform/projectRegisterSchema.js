/**
 * Project Register Schema (Tenant DB)
 *
 * Tracks funded project registrations and delivery status.
 */

import mongoose from 'mongoose';

const projectRegisterSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  project_code: {
    type: String,
    trim: true,
    index: true
  },
  agreement_title: {
    type: String,
    trim: true
  },
  agreement_id: {
    type: mongoose.Schema.Types.ObjectId
  },
  project_name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  planned_start_date: {
    type: Date
  },
  planned_end_date: {
    type: Date
  },
  status: {
    type: String,
    enum: ['active', 'pending', 'at_risk', 'completed'],
    default: 'pending',
    index: true
  },
  phase: {
    type: String,
    trim: true
  },
  warning: {
    type: String,
    trim: true
  },
  // Project handoff/delivery locking (set after completion workflow).
  delivery_status: {
    type: String,
    enum: ['not_started', 'in_progress', 'delivered_and_handed_off'],
    default: 'not_started',
    index: true
  },
  delivery_locked_at: {
    type: Date
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'project_register'
});

projectRegisterSchema.index({ org_id: 1, status: 1 });
projectRegisterSchema.index({ org_id: 1, createdAt: -1 });

export default projectRegisterSchema;
