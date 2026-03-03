/**
 * BCP Emergency Activation Schema
 * 
 * Tracks real-time emergency events and their resolution workflow
 * Automatic escalation to trustees is mandatory
 */

import mongoose from 'mongoose';

const discussionLogSchema = new mongoose.Schema({
  participant_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  message: {
    type: String,
    required: true
  },
  attachments: [{
    filename: String,
    filepath: String
  }],
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const decisionLogSchema = new mongoose.Schema({
  decision: {
    type: String,
    required: true
  },
  made_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['team_member', 'team_lead', 'trustee'],
    required: true
  },
  rationale: {
    type: String
  },
  action_items: [{
    action: String,
    assigned_to_position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    due_date: Date,
    completed: { type: Boolean, default: false },
    completed_at: Date
  }],
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const trusteeEndorsementSchema = new mongoose.Schema({
  trustee_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  endorsement: {
    type: String,
    enum: ['approved', 'rejected', 'requires_modification'],
    required: true
  },
  comments: String,
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const bcpEmergencyActivationSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  emergency_code: {
    type: String,
    unique: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['financial', 'it_technology', 'legal_compliance', 'key_personnel', 'natural_disaster', 'security_breach', 'other'],
    required: true
  },
  severity: {
    type: String,
    enum: ['minor', 'moderate', 'major', 'critical'],
    required: true
  },
  status: {
    type: String,
    enum: ['triggered', 'team_notified', 'in_discussion', 'escalated_to_trustees', 'resolved', 'closed'],
    default: 'triggered'
  },
  
  triggered_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  triggered_at: {
    type: Date,
    default: Date.now
  },
  
  linked_risk_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BcpRisk'
  },
  
  emergency_team_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BcpEmergencyTeam'
  },
  
  team_notified_at: {
    type: Date
  },
  team_notification_log: [{
    position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    notified_at: Date,
    acknowledged_at: Date,
    acknowledged_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  
  discussion_phase: {
    started_at: Date,
    ended_at: Date
  },
  discussion_log: [discussionLogSchema],
  
  decisions: [decisionLogSchema],
  
  escalated_to_trustees_at: {
    type: Date
  },
  trustee_endorsements: [trusteeEndorsementSchema],
  
  resolution: {
    summary: String,
    actions_taken: [String],
    lessons_learned: String,
    follow_up_required: Boolean,
    follow_up_actions: [String],
    resolved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    resolved_at: Date
  },
  
  closed_at: {
    type: Date
  },
  closed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  attachments: [{
    filename: String,
    filepath: String,
    uploaded_at: { type: Date, default: Date.now },
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  
  audit_export_generated: {
    type: Boolean,
    default: false
  },
  audit_export_path: String,
  
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Generate emergency code before save
bcpEmergencyActivationSchema.pre('save', async function(next) {
  if (!this.emergency_code) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.emergency_code = `EMG-${year}${month}-${random}`;
  }
  next();
});

bcpEmergencyActivationSchema.index({ org_id: 1, status: 1 });
bcpEmergencyActivationSchema.index({ org_id: 1, triggered_at: -1 });

export default bcpEmergencyActivationSchema;
