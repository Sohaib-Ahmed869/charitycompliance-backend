/**
 * Approval Matrix Schema (Tenant DB)
 * 
 * Defines approval workflows and rules for different actions
 */

import mongoose from 'mongoose';

const approvalRuleSchema = new mongoose.Schema({
  action_type: {
    type: String,
    required: true,
    // IMPORTANT: keep this aligned with UI "tags" so workflows apply correctly.
    // We keep legacy values for backwards compatibility.
    enum: [
      'expense',
      'purchase',
      'grant',
      'contract',
      'leave',
      'hr',
      'policy',
      'risk',
      // legacy
      'policy_approval',
      'document_approval',
      'budget_approval',
      'risk_management',
      'grant_approval',
      'other'
    ]
  },
  min_amount: {
    type: Number,
    default: 0
  },
  max_amount: {
    type: Number
  },
  requires_approval_from: [{
    position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    department_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department'
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    approval_level: {
      type: Number,
      required: true,
      min: 1
    }
  }],
  approval_type: {
    type: String,
    enum: ['sequential', 'parallel', 'any'],
    default: 'sequential'
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, { _id: true });

const approvalMatrixSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  priority: {
    type: Number,
    description: 'Priority of the workflow (higher number = higher priority)',
    default: 0
  },
  rules: [approvalRuleSchema],
  default_approver: {
    position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  is_default: {
    type: Boolean,
    default: false
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  collection: 'approval_matrices'
});

approvalMatrixSchema.index({ org_id: 1 });
approvalMatrixSchema.index({ org_id: 1, is_default: 1 });

export default approvalMatrixSchema;
