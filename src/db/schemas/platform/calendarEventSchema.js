/**
 * Calendar Event Schema (Tenant DB)
 * 
 * Calendar events for users including custom events and system-generated events
 */

import mongoose from 'mongoose';

const calendarEventSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  date: {
    type: Date,
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['policy', 'training', 'grant', 'funding', 'compliance', 'meeting', 'custom'],
    default: 'custom'
  },
  description: {
    type: String,
    trim: true
  },
  color: {
    type: String,
    trim: true
  },
  completed: {
    type: Boolean,
    default: false,
    index: true
  },
  is_custom: {
    type: Boolean,
    default: true,
    index: true
  },
  source: {
    type: String,
    enum: ['custom', 'policy', 'training', 'grant', 'compliance'],
    default: 'custom'
  },
  source_id: {
    type: mongoose.Schema.Types.ObjectId,
    // Dynamic reference - could be to Policy, Training, etc.
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: false // We're using custom created_at/updated_at
});

// Indexes
calendarEventSchema.index({ user_id: 1, date: 1 });
calendarEventSchema.index({ user_id: 1, is_custom: 1 });
calendarEventSchema.index({ type: 1, date: 1 });

// Update updated_at before saving
calendarEventSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default calendarEventSchema;
