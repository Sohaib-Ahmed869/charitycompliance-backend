/**
 * Meeting Schema (Tenant DB)
 * 
 * Meetings: Board/Trustee, General, Resolution-based
 */

import mongoose from 'mongoose';

const meetingSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  meeting_type: {
    type: String,
    enum: ['board_trustee', 'general', 'resolution'],
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  agenda: {
    type: String,
    required: true,
    trim: true
  },
  date: {
    type: Date,
    required: true,
    index: true
  },
  duration_minutes: {
    type: Number,
    default: 60
  },
  location: {
    type: String,
    trim: true
  },
  meeting_link: {
    type: String,
    trim: true
  },
  meeting_notes: {
    type: String,
    trim: true
  },
  
  // Internal notes (private notes only visible to organizers)
  internal_notes: [{
    note: { type: String, required: true, trim: true },
    added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    added_at: { type: Date, default: Date.now },
    completed: { type: Boolean, default: false },
    documents: [{
      file_name: { type: String, required: true },
      file_path: { type: String, required: true },
      file_size: { type: Number },
      mime_type: { type: String },
      uploaded_at: { type: Date, default: Date.now }
    }]
  }],
  
  // Standalone meeting documents (not tied to a specific note)
  meeting_documents: [{
    file_name: { type: String, required: true },
    file_path: { type: String, required: true },
    file_size: { type: Number },
    mime_type: { type: String },
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploaded_at: { type: Date, default: Date.now }
  }],
  
  // Mark meeting as important
  is_important: {
    type: Boolean,
    default: false
  },
  
  // Task status for tracking
  task_status: {
    type: String,
    enum: ['waiting', 'in_progress', 'in_review', 'approved'],
    default: 'waiting'
  },
  
  // Attendees (internal system users)
  attendees: [{
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    attendance_status: {
      type: String,
      enum: ['invited', 'confirmed', 'declined', 'attended'],
      default: 'invited'
    },
    rsvp_token: { type: String, trim: true },
    rsvp_at: { type: Date, default: null }
  }],
  
  // External attendees (non-system users, identified by email)
  external_attendees: [{
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    organization: {
      type: String,
      trim: true
    },
    attendance_status: {
      type: String,
      enum: ['invited', 'confirmed', 'declined', 'attended'],
      default: 'invited'
    },
    rsvp_token: { type: String, trim: true },
    rsvp_at: { type: Date, default: null }
  }],
  
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Recurring series (Board/Trustee): when set, system can generate upcoming instances for all
  recurrence_rule: {
    type: String,
    enum: ['none', 'monthly', 'quarterly'],
    default: 'none',
    index: true
  },
  recurrence_series_id: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },

  // Board/Trustee specific
  board_meeting_info: {
    is_mandatory: { type: Boolean, default: true },
    compliance_checklist: [{
      item: String,
      // `selected` = "this item is on the agenda for this meeting". User picks
      // the agenda at creation time; only selected items show during the meeting
      // and gate completion. Items missing this field (legacy meetings created
      // before this concept existed) are treated as selected by the FE for
      // backward compat.
      selected: { type: Boolean, default: false },
      completed: { type: Boolean, default: false },
      checked_at: Date
    }],
    registers_reviewed: {
      risk_register: { type: Boolean, default: false },
      coi_register: { type: Boolean, default: false },
      bcp_status: { type: Boolean, default: false },
      escalations: { type: Boolean, default: false }
    },
    visibility: {
      type: String,
      enum: ['trustee_only', 'restricted'],
      default: 'trustee_only'
    }
  },
  
  // General Meeting specific
  general_meeting_info: {
    visibility: {
      type: String,
      enum: ['selected_attendees', 'role_based', 'public'],
      default: 'selected_attendees'
    },
    allowed_roles: [String],
    ai_summary: { type: String, trim: true }
  },
  
  // Resolution/Workflow specific
  resolution_meeting_info: {
    triggered_by: {
      type: String,
      enum: ['risk', 'complaint', 'bcp', 'disciplinary'],
      index: true
    },
    relationship_id: {
      type: mongoose.Schema.Types.ObjectId,
      // Can reference Risk, Complaint, BCP, or Disciplinary record
    },
    workflow_escalation_trail: [{
      escalated_to_role: String,
      escalated_at: Date,
      action: String,
      status: String
    }],
    requires_board_escalation: { type: Boolean, default: false },
    escalated_to_board_at: Date,
    resolution_status: {
      type: String,
      enum: ['pending', 'discussed', 'resolved', 'escalated'],
      default: 'pending'
    },
    final_resolution: String
  },
  
  // Completion audit (tracks who marked the meeting as complete)
  completion_audit: {
    completed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    completed_at: Date,
    completion_signature: String, // Base64 data URL of e-signature
    completion_checklist_snapshot: [{ // Record of items checked at completion
      item: String,
      completed: Boolean,
      checked_at: Date
    }]
  },
  
  // Audit & Access control
  is_exported_for_audit: { type: Boolean, default: false },
  exported_at: Date,
  restricted_access_roles: [String],
  
  status: {
    type: String,
    enum: ['scheduled', 'in_progress', 'completed', 'cancelled'],
    default: 'scheduled',
    index: true
  },
  
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  cancelled_at: Date,
  completed_at: Date,

  /** Tracks which reminder phase already ran for a given scheduled start (compared to `date`); rescheduling clears mismatch automatically */
  reminder_sent: {
    one_hour_for_date: { type: Date, default: null },
    fifteen_min_for_date: { type: Date, default: null }
  }
}, {
  timestamps: true,
  collection: 'meetings'
});

meetingSchema.index({ org_id: 1, meeting_type: 1 });
meetingSchema.index({ org_id: 1, date: -1 });
meetingSchema.index({ org_id: 1, status: 1 });
meetingSchema.index({ org_id: 1, created_by: 1 });

meetingSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default meetingSchema;
