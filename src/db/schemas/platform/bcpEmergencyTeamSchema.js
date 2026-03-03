/**
 * BCP Emergency Response Team Schema
 * 
 * Defines emergency response teams with position-based membership
 * Positions can be reassigned without changing team structure
 */

import mongoose from 'mongoose';

const teamMemberSchema = new mongoose.Schema({
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    required: true
  },
  role_in_team: {
    type: String,
    enum: ['chair', 'finance_lead', 'it_lead', 'legal_lead', 'hr_lead', 'operations_lead', 'communications_lead', 'member'],
    required: true
  },
  backup_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  escalates_to_trustee: {
    type: Boolean,
    default: false
  },
  responsibilities: {
    type: String
  },
  added_at: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const bcpEmergencyTeamSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  team_name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String
  },
  members: [teamMemberSchema],
  status: {
    type: String,
    enum: ['active', 'inactive', 'archived'],
    default: 'active'
  },
  activation_protocol: {
    type: String,
    default: 'standard'
  },
  // When true, authority transfers linked to this team must go through
  // a team-based approval workflow (only team members can approve).
  workflow_enabled: {
    type: Boolean,
    default: false
  },
  workflow_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix'
  },
  contact_order: [{
    position_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Position'
    },
    priority: Number
  }],
  last_drill_date: {
    type: Date
  },
  next_review_date: {
    type: Date
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

bcpEmergencyTeamSchema.index({ org_id: 1, status: 1 });

export default bcpEmergencyTeamSchema;
