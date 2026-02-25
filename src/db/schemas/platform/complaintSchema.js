/**
 * Complaint Schema
 * 
 * Stores complaint submissions in the complaint register
 */

import mongoose from 'mongoose';

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
