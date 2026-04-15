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
      'donor',
      'donation',
      'donation_agreement',
      'donation_milestone',
      'social_media_campaign',
      'contract',
      'leave',
      'hr',
      'policy',
      'complaint',
      'risk',
      'risk_treatment',
      'coi',
      'partner_vetting',
      'funding_agreement',
      'project',
      'emergency',
      'sweep_funds',
      'financial_reporting',
      'bas_lodgement',
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
      'complaint_resolution',
      'coi',
      'partner_vetting',
      'policy_approval',
      'hr_approval',
      'funding_agreement',
      'expense_approval',
      'project_approval',
      'grant_approval',
      'donor_review',
      'donation_workflow',
      'donation_agreement_workflow',
      'donation_milestone_workflow',
      'social_media_campaign_workflow',
      'emergency',
      'sweep_funds_approval',
      'fiscal_reports_workflow',
      'financial_reports_workflow',
      'other'
    ],
    description: 'Categorizes workflow by module/purpose for validation'
  },
  workflow_type: {
    type: String,
    enum: [
      'high', 'medium', 'low',                        // Risk types
      'petty_cash', 'low_cash', 'moderate_cash', 'high_cash',  // Financial types
      'small', 'large'                                // Donor/Grant size types (medium reused from risk types)
    ],
    description: 'Type designation: Risk uses high/medium/low, Financial uses cash tiers, Donor/Grant uses small/medium/large'
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
  },

  // ── Effective dates + revocation ──────────────────────────────────────────
  effective_from: {
    type: Date,
    default: null,
    index: true
  },
  effective_to: {
    type: Date,
    default: null,
    index: true
  },
  revoked_at: {
    type: Date,
    default: null,
    index: true
  },
  revoked_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },

  // ── Audit metadata (who changed workflows) ───────────────────────────────
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  }
}, {
  timestamps: true,
  collection: 'approval_matrices'
});

approvalMatrixSchema.index({ org_id: 1 });
approvalMatrixSchema.index({ org_id: 1, is_default: 1 });

// Helper: human‑readable names for workflow categories (used in validation errors)
const getCategoryDisplayName = (category) => {
  const categoryNames = {
    risk_management: 'Risk Management',
    risk_treatment: 'Risk Treatment',
    complaint_resolution: 'Complaint Resolution',
    coi: 'Conflict of Interest',
    partner_vetting: 'Partner Vetting',
    funding_agreement: 'Funding Agreement',
    project_approval: 'Project Approval',
    expense_approval: 'Expense Approval',
    policy_approval: 'Policy Approval',
    donor_review: 'Donor Review',
    grant_approval: 'Grant Approval',
    donation_workflow: 'Donations',
    donation_agreement_workflow: 'Donation Funding Agreements',
    donation_milestone_workflow: 'Donation Milestones',
    social_media_campaign_workflow: 'Social Media Campaigns',
    hr_approval: 'HR Approval',
    sweep_funds_approval: 'Sweep Funds',
    fiscal_reports_workflow: 'Fiscal Reports',
    financial_reports_workflow: 'Financial Reports',
    emergency: 'Emergency Response'
  };
  return categoryNames[category] || category;
};

// Validation: workflow_category and workflow_type rules
approvalMatrixSchema.pre('save', async function(next) {
  const doc = this;

  // Effective date sanity
  if (doc.effective_from && doc.effective_to) {
    if (new Date(doc.effective_from) > new Date(doc.effective_to)) {
      return next(new Error('Workflow effective end date must be after the effective start date'));
    }
  }

  // Revocation implies inactive
  if (doc.revoked_at && doc.is_active) {
    doc.is_active = false;
  }
  
  // Risk management must have workflow_type (high/medium/low)
  if (doc.workflow_category === 'risk_management') {
    if (!doc.workflow_type || !['high', 'medium', 'low'].includes(doc.workflow_type)) {
      return next(new Error('Risk Management workflows must have workflow_type: high, medium, or low'));
    }
  }
  
  // Donor review must have workflow_type (small/medium/large)
  if (doc.workflow_category === 'donor_review') {
    if (!doc.workflow_type || !['small', 'medium', 'large'].includes(doc.workflow_type)) {
      return next(new Error('Donor Review workflows must have workflow_type: small, medium, or large'));
    }
  }
  
  // Grant approval must have workflow_type (small/medium/large)
  if (doc.workflow_category === 'grant_approval') {
    if (!doc.workflow_type || !['small', 'medium', 'large'].includes(doc.workflow_type)) {
      return next(new Error('Grant Approval workflows must have workflow_type: small, medium, or large'));
    }
  }
  
  // Single-workflow categories: no workflow_type allowed
  const singleWorkflowCategories = ['coi', 'partner_vetting', 'policy_approval', 'hr_approval', 'risk_treatment', 'complaint_resolution'];
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
  const financialCategories = ['funding_agreement', 'expense_approval', 'project_approval', 'sweep_funds_approval', 'fiscal_reports_workflow', 'financial_reports_workflow'];
  if (financialCategories.includes(doc.workflow_category)) {
    if (!doc.workflow_type || !['petty_cash', 'low_cash', 'moderate_cash', 'high_cash'].includes(doc.workflow_type)) {
      return next(new Error('Financial workflows must have workflow_type: petty_cash, low_cash, moderate_cash, or high_cash'));
    }
  }

  next();
});

export default approvalMatrixSchema;
