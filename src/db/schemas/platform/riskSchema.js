/**
 * Risk Schema (Tenant DB)
 *
 * Organisational risks for governance and compliance
 */

import mongoose from 'mongoose';

const riskSchema = new mongoose.Schema({
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
  description: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  department: {
    type: String,
    trim: true
  },
  /** Department ref for approval workflow (department head as first approver) */
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    index: true
  },
  risk_owner_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  /** Responsible person (board member) as risk owner; used when no User link or for display */
  risk_owner_board_member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BoardMember',
    index: true
  },
  next_review_date: {
    type: Date,
    index: true
  },
  // Severity fields are set by the department head during first-step approval,
  // so they're optional at create time (two-phase risk approval).
  likelihood: {
    type: Number,
    min: 1,
    max: 5
  },
  consequence: {
    type: Number,
    min: 1,
    max: 5
  },
  inherent_risk_score: {
    type: Number,
    min: 1,
    max: 25
  },
  inherent_risk_level: {
    type: String,
    enum: ['low', 'moderate', 'high', 'extreme', 'critical']
  },
  residual_risk_score: {
    type: Number,
    min: 0,
    max: 25
  },
  residual_risk_level: {
    type: String,
    enum: ['low', 'moderate', 'high', 'extreme', 'critical']
  },
  existing_controls: {
    type: String,
    default: ''
  },
  trend: {
    type: String,
    enum: ['improving', 'stable', 'worsening', 'unknown'],
    default: 'stable'
  },
  status: {
    type: String,
    enum: ['draft', 'pending', 'under_treatment', 'approved', 'resolved', 'rejected', 'resubmission_required', 'closed'],
    default: 'draft',
    index: true
  },
  approval_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix'
  },
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  },
  /** Simple semantic version for risk (v1.0, v1.1, etc.) */
  version: {
    type: String,
    default: 'v1.0'
  },
  submitted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  /** Attachments for the risk (documents, evidence, etc.) */
  attachments: [{
    file_path: { type: String },
    file_name: { type: String },
    file_size: { type: Number },
    mime_type: { type: String },
    uploaded_at: { type: Date, default: Date.now }
  }],
  /** Treatments and controls for this risk */
  treatments: [{
    control_action: { type: String, trim: true, default: '' },
    owner: { type: String, trim: true, default: '' },
    due_date: { type: Date },
    status: {
      type: String,
      enum: ['pending', 'under_treatment', 'implemented', 'resolved'],
      default: 'pending'
    },
    evidence: [{
      file_path: { type: String },
      file_name: { type: String },
      file_size: { type: Number },
      mime_type: { type: String },
      uploaded_at: { type: Date, default: Date.now }
    }]
  }],
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  volunteer_submission: {
    source: { type: String, enum: ['volunteer_link'], default: null },
    board_member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BoardMember', default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    action_token: { type: String, default: null },
    action_type: { type: String, enum: ['complaint', 'risk', 'coi'], default: null },
    submitted_at: { type: Date, default: null }
  }
}, {
  timestamps: true,
  collection: 'risks'
});

riskSchema.index({ org_id: 1, status: 1 });
riskSchema.index({ org_id: 1, next_review_date: 1 });
riskSchema.index({ org_id: 1, created_at: -1 });
riskSchema.index({ approval_request_id: 1 });

export default riskSchema;
