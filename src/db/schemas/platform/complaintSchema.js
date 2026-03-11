/**
 * Complaint Schema
 * 
 * Stores complaint submissions in the complaint register
 */

import mongoose from 'mongoose';

const complaintTrailEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    actor_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true, trim: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const complaintEscalationEntrySchema = new mongoose.Schema(
  {
    from_stage: { type: String, trim: true },
    to_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, trim: true },
    created_at: { type: Date, default: Date.now },
    resolved_at: { type: Date, default: null },
  },
  { _id: true }
);

const complaintBoardSignoffSchema = new mongoose.Schema(
  {
    signed_at: { type: Date, default: null },
    signed_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    signature_data: { type: String, default: null },
    notes: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const complaintSchema = new mongoose.Schema(
  {
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    complainant_name: {
      type: String,
      required: true,
      trim: true,
    },
    complainant_email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    complainant_occupation: {
      type: String,
      trim: true,
    },
    complaint_title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true,
    },
    submit_anonymously: {
      type: Boolean,
      default: false,
    },
    submission_method: {
      type: String,
      enum: ['website', 'public_link', 'qr_code', 'external_embed'],
      required: true,
    },
    status: {
      type: String,
      enum: ['new', 'assigned', 'in_progress', 'resolved'],
      default: 'new',
    },
    workflow_stage: {
      type: String,
      enum: ['admin_triage', 'dept_head_review', 'board_signoff', 'resolved'],
      default: 'admin_triage',
      index: true,
    },
    is_major: {
      type: Boolean,
      default: false,
      index: true,
    },
    board_signoff_board_member_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BoardMember',
      default: null,
      index: true,
    },
    board_signoff_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
      trim: true,
    },
    attachments: [
      {
        filename: {
          type: String,
          trim: true,
        },
        size: {
          type: String,
          trim: true,
        },
        mime: {
          type: String,
          trim: true,
        },
        data_url: {
          type: String,
        },
        uploaded_at: {
          type: Date,
          default: Date.now,
        },
        uploaded_by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      },
    ],
    resolution_details: {
      root_cause: {
        type: String,
        trim: true,
      },
      resolution: {
        type: String,
        trim: true,
      },
      corrective_actions: {
        type: String,
        trim: true,
      },
      preventive_actions: {
        type: String,
        trim: true,
      },
      lessons_learned: {
        type: String,
        trim: true,
      },
      completed_at: {
        type: Date,
      },
      risk_linked_at: {
        type: Date,
      },
      training_linked_at: {
        type: Date,
      },
      resolved_at: {
        type: Date,
      },
    },
    linked_risk_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Risk',
    },
    linked_training_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingProgram',
    },
    training_attachment: {
      training_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TrainingProgram',
      },
      training_title: {
        type: String,
        trim: true,
      },
      notes: {
        type: String,
        trim: true,
      },
    },
    escalation_stack: {
      type: [complaintEscalationEntrySchema],
      default: [],
    },
    trail: {
      type: [complaintTrailEntrySchema],
      default: [],
    },
    board_signoff: {
      type: complaintBoardSignoffSchema,
      default: () => ({}),
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export default complaintSchema;
