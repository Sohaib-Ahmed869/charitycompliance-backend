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
      'risk_treatment',
      'coi',
      'partner_vetting',
      'funding_agreement',
      'project',
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
  workflow_category: {
    type: String,
    enum: [
      'risk_management',
      'risk_treatment',
      'coi',
      'partner_vetting',
      'policy_approval',
      'hr_approval',
      'funding_agreement',
      'expense_approval',
      'project_approval',
      'other'
    ],
    description: 'Categorizes workflow by module/purpose for validation'
  },
  workflow_type: {
    type: String,
    enum: [
      'high', 'medium', 'low',                        // Risk types
      'petty_cash', 'low_cash', 'moderate_cash', 'high_cash'  // Financial types
    ],
    description: 'Type designation: Risk uses high/medium/low, Financial uses cash tiers'
  },
  priority: {
    type: Number,
    description: 'Priority of the workflow (higher number = higher priority). Maps: High=3, Medium=2, Low=1',
    default: 0
  },
  priority_level: {
    type: String,
    enum: ['high', 'medium', 'low'],
    description: 'Human-readable priority: High, Medium, Low'
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

// Validation: workflow_category and workflow_type rules
approvalMatrixSchema.pre('save', async function(next) {
  const doc = this;
  
  // Risk management must have workflow_type (high/medium/low)
  if (doc.workflow_category === 'risk_management') {
    if (!doc.workflow_type || !['high', 'medium', 'low'].includes(doc.workflow_type)) {
      return next(new Error('Risk Management workflows must have workflow_type: high, medium, or low'));
    }
  }
  
  // COI, Partner Vetting, Policy, HR, Risk Treatment: no workflow_type allowed
  const singleWorkflowCategories = ['coi', 'partner_vetting', 'policy_approval', 'hr_approval', 'risk_treatment'];
  if (singleWorkflowCategories.includes(doc.workflow_category)) {
    if (doc.workflow_type) {
      return next(new Error(`${getCategoryDisplayName(doc.workflow_category)} workflows cannot have a workflow type`));
    }
    
    // Only one workflow allowed per category - check if another exists
    const existingCount = await this.constructor.countDocuments({
      org_id: doc.org_id,
      workflow_category: doc.workflow_category,
      _id: { $ne: doc._id },
      is_active: true
    });
    
    if (existingCount > 0) {
      return next(new Error(`Only one active ${getCategoryDisplayName(doc.workflow_category)} workflow is allowed per organization`));
    }
  }
  
  // Financial workflows: must have workflow_type matching threshold tiers
  const financialCategories = ['funding_agreement', 'expense_approval', 'project_approval'];
  if (financialCategories.includes(doc.workflow_category)) {
    if (!doc.workflow_type || !['petty_cash', 'low_cash', 'moderate_cash', 'high_cash'].includes(doc.workflow_type)) {
      return next(new Error('Financial workflows must have workflow_type: petty_cash, low_cash, moderate_cash, or high_cash'));
    }
  }
  
  next();
});

export default approvalMatrixSchema;
