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
    // Optional: when no user is currently assigned to the position,
    // approver_user_id may be null while approver_position_id/approver_department_id
    // still indicate who should approve once a user is assigned.
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
  /** True when this step is the department head (must approve first before workflow steps) */
  is_department_head: {
    type: Boolean,
    default: false
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
  acknowledgement_note: {
    type: String
  },
  acknowledgement_files: [{
    name: { type: String },
    size: { type: Number },
    file_type: { type: String },
    url: { type: String },
    key: { type: String }
  }],
  attachments: [{
    type: String
  }],
  ip_address: {
    type: String
  },
  user_agent: {
    type: String
  },
  /** Optional e‑signature captured for this approval step (base64 data URL) */
  signature_data: {
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
    // IMPORTANT: keep this aligned with ApprovalMatrix.rules.action_type (UI tags).
    // Keep legacy values for backwards compatibility.
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
      'partner_vetting',
      'funding_agreement',
      'project',
      'emergency',
      'project_delivery',
      'project_delivery_changes',
      'sweep_funds',
      // legacy
      'policy_approval',
      'document_approval',
      'budget_approval',
      'risk_management',
      'grant_approval',
      'complaint_resolution',
      'other'
    ],
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
    enum: [
      'expense',
      'purchase',
      'policy',
      'document',
      'budget',
      'risk',
      'grant',
      'donor',
      'donation',
      'donation_agreement',
      'donation_milestone',
      'social_media_campaign',
      'partner',
      'funding_agreement',
      'project',
      'authority_transfer',
      'complaint',
      'other'
    ]
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  approval_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix',
    // Optional because two-phase approvals (e.g. risk HoD severity assessment)
    // create the request BEFORE the priority-matched matrix is known. The
    // matrix is attached once the department head decides severity.
    required: false,
    default: null
  },
  approval_type: {
    type: String,
    enum: ['sequential', 'parallel', 'any'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'pending_rejection_review', 'rejection_accepted', 'returned_for_resubmission', 'paused_for_coi'],
    default: 'pending',
    index: true
  },
  approval_steps: [approvalStepSchema],
  submitted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  /**
   * Change control note for the CURRENT attempt (what changed since last submission/version).
   * This is shown to approvers in the workflow detail view.
   */
  change_control: {
    type: String,
    default: null
  },
  /** For risk_treatment requests: index of the treatment in risk.treatments array */
  treatment_index: {
    type: Number,
    min: 0
  },
  sweep_funds: {
    source_portal: { type: String },
    source_account_identifier: { type: String },
    destination_asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset' },
    destination_account_label: { type: String },
    receipt_files: [{
      name: { type: String },
      size: { type: Number },
      file_type: { type: String },
      url: { type: String },
      key: { type: String }
    }],
    audit_trail: [{
      action: { type: String },
      by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      comments: { type: String },
      created_at: { type: Date, default: Date.now }
    }]
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
  },
  paused_step_index: {
    type: Number
  },
  paused_at: {
    type: Date
  },
  current_coi_request_id: {
    type: mongoose.Schema.Types.ObjectId
  },
  coi_request_ids: [{
    type: mongoose.Schema.Types.ObjectId
  }],
  // Rejection Review Tracking
  rejection_reviews: [{
    rejected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    forwarded_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    step_index: {
      type: Number,
      required: true
    },
    rejection_comments: {
      type: String,
      required: true
    },
    review_status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending'
    },
    review_action: {
      type: String,
      enum: ['accept_rejection', 'reject_rejection', null],
      default: null
    },
    review_comments: {
      type: String
    },
    reviewed_at: {
      type: Date
    },
    rejection_files: [{
      name: { type: String },
      size: { type: Number },
      file_type: { type: String },
      url: { type: String },
      key: { type: String }
    }],
    created_at: {
      type: Date,
      default: Date.now
    },
    // Store original step data for pre-fill when returning to rejector
    original_step_data: {
      type: mongoose.Schema.Types.Mixed
    }
  }],
  current_rejection_review_id: {
    type: mongoose.Schema.Types.ObjectId
  },
  rejection_loop_count: {
    type: Number,
    default: 0
  },
  /** Snapshots of previous attempts (before resubmission) - preserves full history */
  previous_attempts: [{
    attempt_number: { type: Number },
    steps_snapshot: { type: mongoose.Schema.Types.Mixed },
    saved_at: { type: Date, default: Date.now },
    reason: { type: String, default: 'rejection_upheld' },
    /** Optional change control note entered by submitter when resubmitting */
    change_control: { type: String }
  }],
  /** Ad‑hoc escalations for opinions (does not change approver of the step) */
  escalations: [{
    step_index: { type: Number, required: true },
    escalated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    escalated_to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['pending', 'responded'],
      default: 'pending'
    },
    request_comments: { type: String }, // escalator's question when creating escalation
    request_files: [{
      name: { type: String },
      size: { type: Number },
      file_type: { type: String },
      url: { type: String },
      key: { type: String }
    }],
    comments: { type: String }, // opinion/response from escalated person
    files: [{
      name: { type: String },
      size: { type: Number },
      file_type: { type: String },
      url: { type: String },
      key: { type: String }
    }],
    created_at: { type: Date, default: Date.now },
    responded_at: { type: Date }
  }]
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
