/**
 * Approval Request Schema (Tenant DB)
 * 
 * Tracks approval requests and their steps
 */

import mongoose from 'mongoose';

const approvalStepSchema = new mongoose.Schema({
  level: {
    type: Number,
    required: true,
    min: 1
  },
  approver_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approver_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  approver_department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department'
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  approved_at: {
    type: Date
  },
  rejected_at: {
    type: Date
  },
  comments: {
    type: String
  },
  rejection_reason: {
    type: String
  },
  attachments: [{
    type: String // File paths/URLs
  }],
  ip_address: {
    type: String
  },
  user_agent: {
    type: String
  }
}, { _id: true });

const approvalRequestSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  request_type: {
    type: String,
    required: true,
    enum: ['expense', 'purchase', 'policy_approval', 'document_approval', 'budget_approval', 'other'],
    index: true
  },
  entity_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  entity_type: {
    type: String,
    required: true,
    enum: ['expense', 'purchase', 'policy', 'document', 'budget', 'other']
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  approval_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix',
    required: true
  },
  approval_type: {
    type: String,
    enum: ['sequential', 'parallel', 'any'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  approval_steps: [approvalStepSchema],
  submitted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  completed_at: {
    type: Date
  },
  cancelled_at: {
    type: Date
  },
  cancelled_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancellation_reason: {
    type: String
  }
}, {
  timestamps: true,
  collection: 'approval_requests'
});

approvalRequestSchema.index({ org_id: 1, status: 1 });
approvalRequestSchema.index({ org_id: 1, submitted_by: 1 });
approvalRequestSchema.index({ entity_id: 1, entity_type: 1 });
approvalRequestSchema.index({ 'approval_steps.approver_user_id': 1, 'approval_steps.status': 1 });
approvalRequestSchema.index({ org_id: 1, created_at: -1 });

export default approvalRequestSchema;
