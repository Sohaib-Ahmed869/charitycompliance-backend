/**
 * Position Schema (Tenant DB)
 * 
 * Job positions/roles within the organization
 */

import mongoose from 'mongoose';

const positionSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    trim: true,
    uppercase: true
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true
  },
  description: {
    type: String
  },
  reporting_to_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  level: {
    type: Number,
    default: 1,
    min: 1
  },
  min_salary: {
    type: Number
  },
  max_salary: {
    type: Number
  },
  required_skills: [String],
  required_qualifications: [String],
  is_management: {
    type: Boolean,
    default: false
  },
  can_approve_expenses: {
    type: Boolean,
    default: false
  },
  max_approval_amount: {
    type: Number,
    default: 0
  },
  is_active: {
    type: Boolean,
    default: true
  },
  current_occupant_count: {
    type: Number,
    default: 0
  },
  max_occupants: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true,
  collection: 'positions'
});

positionSchema.index({ org_id: 1, title: 1, department_id: 1 });
positionSchema.index({ org_id: 1, code: 1 }, { unique: true, sparse: true });
positionSchema.index({ org_id: 1, department_id: 1 });

export default positionSchema;
