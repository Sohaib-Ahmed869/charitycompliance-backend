/**
 * BCP Risk Register Schema
 * 
 * Risk entries for Business Continuity Planning
 * Categories: Financial, IT/Technology, Legal & Compliance, Key Personnel
 */

import mongoose from 'mongoose';

const fallbackStrategySchema = new mongoose.Schema({
  strategy: {
    type: String,
    required: true
  },
  responsible_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  resources_required: {
    type: String
  },
  estimated_recovery_time: {
    type: String
  },
  tested: {
    type: Boolean,
    default: false
  },
  last_tested_date: {
    type: Date
  }
}, { _id: true });

const escalationLogSchema = new mongoose.Schema({
  escalated_to: {
    type: String,
    enum: ['team_lead', 'emergency_team', 'trustee'],
    required: true
  },
  escalated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reason: {
    type: String
  },
  escalated_at: {
    type: Date,
    default: Date.now
  },
  resolved_at: {
    type: Date
  },
  resolution: {
    type: String
  }
}, { _id: true });

const bcpRiskSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  category: {
    type: String,
    enum: ['financial', 'it_technology', 'legal_compliance', 'key_personnel'],
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  impact_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    required: true
  },
  likelihood: {
    type: String,
    enum: ['rare', 'unlikely', 'possible', 'likely', 'almost_certain'],
    required: true
  },
  risk_score: {
    type: Number,
    min: 1,
    max: 25
  },
  status: {
    type: String,
    enum: ['identified', 'assessed', 'mitigated', 'monitoring', 'closed', 'escalated'],
    default: 'identified'
  },
  
  // Category-specific fields
  // Financial
  financial_details: {
    funding_dependency: String,
    contingency_reserve_percent: Number,
    scale_back_plan: String,
    bank_signatory_backup: String,
    estimated_financial_impact: Number
  },
  
  // IT/Technology
  it_details: {
    system_affected: String,
    hosting_provider: String,
    domain_owner: String,
    renewal_date: Date,
    credential_owner_position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    dependencies: [String],
    recovery_point_objective: String,
    recovery_time_objective: String
  },
  
  // Legal & Compliance
  legal_details: {
    regulatory_body: String,
    access_owner: String,
    backup_authorized_person_position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    permit_expiry_date: Date,
    agreement_dependencies: [String],
    compliance_requirement: String
  },
  
  // Key Personnel
  personnel_details: {
    key_person_position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    successor_position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    knowledge_transfer_status: {
      type: String,
      enum: ['not_started', 'in_progress', 'completed'],
      default: 'not_started'
    },
    succession_plan_documented: {
      type: Boolean,
      default: false
    },
    automatic_authority_transfer: {
      type: Boolean,
      default: false
    }
  },
  
  fallback_strategies: [fallbackStrategySchema],
  
  assigned_to_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  
  escalation_history: [escalationLogSchema],
  
  review_frequency: {
    type: String,
    enum: ['monthly', 'quarterly', 'semi_annually', 'annually'],
    default: 'quarterly'
  },
  last_review_date: {
    type: Date
  },
  next_review_date: {
    type: Date
  },
  
  attachments: [{
    filename: String,
    filepath: String,
    uploaded_at: { type: Date, default: Date.now },
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Calculate risk score before save
bcpRiskSchema.pre('save', function(next) {
  const impactScores = { low: 1, medium: 2, high: 3, critical: 5 };
  const likelihoodScores = { rare: 1, unlikely: 2, possible: 3, likely: 4, almost_certain: 5 };
  
  this.risk_score = (impactScores[this.impact_level] || 1) * (likelihoodScores[this.likelihood] || 1);
  next();
});

bcpRiskSchema.index({ org_id: 1, category: 1, status: 1 });
bcpRiskSchema.index({ org_id: 1, next_review_date: 1 });

export default bcpRiskSchema;
