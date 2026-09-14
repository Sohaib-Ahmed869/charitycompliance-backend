/**
 * COI Request Schema (Tenant DB)
 * 
 * Separate COI workflows linked to approval requests
 */

import mongoose from 'mongoose';

const coiStepSchema = new mongoose.Schema({
  level: {
    type: Number,
    required: true,
    min: 1
  },
  approver_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
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
    type: String
  }],
  ip_address: {
    type: String
  },
  user_agent: {
    type: String
  }
}, { _id: true });

const coiRequestSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  parent_approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest',
    required: false,
    index: true
  },
  parent_step_index: {
    type: Number,
    required: false
  },
  parent_entity_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: false
  },
  parent_entity_type: {
    type: String,
    required: false
  },
  coi_reason: {
    type: String,
    required: true
  },
  // External submission fields
  submission_source: {
    type: String,
    enum: ['internal', 'external'],
    default: 'internal',
    index: true
  },
  is_external: {
    type: Boolean,
    default: false,
    index: true
  },
  external_submitter: {
    name: {
      type: String,
      required: false
    },
    email: {
      type: String,
      required: false
    },
    phone: {
      type: String,
      required: false
    }
  },
  conflict_person_name: {
    type: String,
    required: false
  },
  conflict_person_details: {
    type: String,
    required: false
  },
  volunteer_submission: {
    source: { type: String, enum: ['volunteer_link'], default: null },
    board_member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BoardMember', default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    action_token: { type: String, default: null },
    action_type: { type: String, enum: ['complaint', 'risk', 'coi'], default: null },
    submitted_at: { type: Date, default: null }
  },
  approval_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix',
    required: false
  },
  approval_type: {
    type: String,
    enum: ['sequential', 'parallel', 'any'],
    required: false
  },
  status: {
    type: String,
    // paused_for_rpt: the COI is halted while a linked Related Party Transaction
    // runs its own approval workflow; it resumes ('pending') when the RPT is approved.
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'paused_for_rpt'],
    default: 'pending',
    index: true
  },
  // Set when this COI spawned an RPT and is halted until that RPT is approved.
  current_rpt_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RelatedPartyTransaction',
    default: null
  },
  // True once the linked RPT has been left UNRESOLVED (declined). The COI stays
  // `paused_for_rpt`, but this flag distinguishes "halted — unresolved RPT" from
  // "on hold — awaiting RPT approval" for status display. Cleared if the RPT is
  // later resolved (approved).
  rpt_unresolved: {
    type: Boolean,
    default: false
  },
  approval_steps: [coiStepSchema],
  submitted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
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
  cancellation_reason: {
    type: String
  }
}, {
  timestamps: true,
  collection: 'coi_requests'
});

coiRequestSchema.index({ org_id: 1, status: 1 });
coiRequestSchema.index({ org_id: 1, submitted_by: 1 });
coiRequestSchema.index({ parent_approval_request_id: 1 });
coiRequestSchema.index({ 'approval_steps.approver_user_id': 1, 'approval_steps.status': 1 });
coiRequestSchema.index({ org_id: 1, is_external: 1, status: 1 });
coiRequestSchema.index({ org_id: 1, submission_source: 1 });

export default coiRequestSchema;
