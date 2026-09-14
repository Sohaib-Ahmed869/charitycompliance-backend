/**
 * Reminder Config (Router DB, GLOBAL / super-admin configurable)
 *
 * Holds the cadence for platform reminder types. Configured once, globally, by
 * a Calcite super-admin (not per-tenant). For now the only configured type is
 * 'approval' — the approval reminder scheduler reads it to decide when to nudge
 * pending approvers.
 *
 *   offsets_hours: hours after a step becomes the current pending step at which
 *                  a reminder should fire (e.g. [24, 48, 72]).
 *   max_reminders: hard cap on reminders per step (belt-and-braces).
 */

import mongoose from 'mongoose';

const reminderConfigSchema = new mongoose.Schema({
  reminder_type: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
    // for now only 'approval'
  },
  enabled: {
    type: Boolean,
    default: true
  },
  // Hours after activation at which reminders fire.
  offsets_hours: {
    type: [Number],
    default: [24, 48, 72]
  },
  max_reminders: {
    type: Number,
    default: 5,
    min: 0
  },
  updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  }
}, {
  timestamps: true,
  collection: 'reminder_configs'
});

export default reminderConfigSchema;
