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
    uppercase: true,
    default: undefined,
    set: (v) => {
      if (v === null || v === undefined) return undefined;
      const s = String(v).trim();
      return s ? s.toUpperCase() : undefined;
    }
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: false // Can be set later
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
  can_approve_risks: {
    type: Boolean,
    default: false
  },
  can_approve_grants: {
    type: Boolean,
    default: false
  },
  can_approve_policies: {
    type: Boolean,
    default: false
  },
  can_approve_hr: {
    type: Boolean,
    default: false
  },
  max_approval_amount: {
    type: Number,
    default: 0
  },
  /** Permissions granted to users in this position (e.g. training:create, training:assign). Org-defined. */
  granted_permissions: {
    type: [String],
    default: []
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
  ,
  /** Module-level permissions for this position. Stored as an array of objects per module. */
  module_permissions: {
    type: [{
      module_id: { type: String, required: true },
      view: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    }],
    default: []
  }
}, {
  timestamps: true,
  collection: 'positions'
});

positionSchema.index({ org_id: 1, title: 1, department_id: 1 });
positionSchema.index({ org_id: 1, code: 1 }, { unique: true, sparse: true });
positionSchema.index({ org_id: 1, department_id: 1 });

// Prevent sparse+unique index collisions on `code: null` by ensuring null/empty are not persisted.
positionSchema.pre('validate', function ensureCodeUndefined(next) {
  if (this.code === null || this.code === undefined) {
    this.code = undefined;
  } else if (typeof this.code === 'string' && this.code.trim() === '') {
    this.code = undefined;
  }
  next();
});

export default positionSchema;
