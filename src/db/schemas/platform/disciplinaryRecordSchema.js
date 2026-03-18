/**
 * Disciplinary Record Schema
 *
 * Used to record staff disciplinary cases, corrective actions and outcomes.
 */

import mongoose from 'mongoose';

const disciplinaryRecordSchema = new mongoose.Schema(
  {
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    staff_member_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    staff_name_snapshot: {
      type: String,
      trim: true
    },
    staff_position_snapshot: {
      type: String,
      trim: true
    },
    issue_type: {
      type: String,
      trim: true,
      required: true
    },
    description: {
      type: String,
      trim: true,
      required: true
    },
    status: {
      type: String,
      enum: ['open', 'investigation', 'resolved', 'declined'],
      default: 'open',
      index: true
    },
    resolution_type: {
      type: String,
      enum: ['training', 'no_action', 'declined', 'other', ''],
      default: ''
    },
    linked_training_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingProgram',
      default: null
    },
    training_title: {
      type: String,
      trim: true
    },
    training_date: {
      type: Date,
      default: null
    },
    resolution_notes: {
      type: String,
      trim: true
    },
    created_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    /** When converted, this disciplinary record is linked to a complaint */
    converted_to_complaint: {
      type: Boolean,
      default: false,
      index: true
    },
    converted_complaint_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Complaint',
      default: null,
      index: true
    },
    converted_at: {
      type: Date,
      default: null
    },
    converted_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    timestamps: true,
    collection: 'disciplinary_records'
  }
);

disciplinaryRecordSchema.index({ org_id: 1, createdAt: -1 });

export default disciplinaryRecordSchema;

