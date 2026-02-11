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
  likelihood: {
    type: Number,
    min: 1,
    max: 5,
    required: true
  },
  consequence: {
    type: Number,
    min: 1,
    max: 5,
    required: true
  },
  inherent_risk_score: {
    type: Number,
    required: true,
    min: 1,
    max: 25
  },
  inherent_risk_level: {
    type: String,
    enum: ['low', 'moderate', 'high', 'extreme', 'critical'],
    required: true
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
    enum: ['draft', 'pending', 'under_treatment', 'approved', 'resolved', 'rejected', 'closed'],
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
  /** Treatments and controls for this risk */
  treatments: [{
    control_action: { type: String, trim: true, default: '' },
    owner: { type: String, trim: true, default: '' },
    due_date: { type: Date },
    status: {
      type: String,
      enum: ['under_treatment', 'implemented', 'resolved'],
      default: 'resolved'
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
