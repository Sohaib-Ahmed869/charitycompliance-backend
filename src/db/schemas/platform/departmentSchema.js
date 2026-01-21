/**
 * Department Schema (Tenant DB)
 * 
 * Organizational departments/divisions
 */

import mongoose from 'mongoose';

const departmentSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    trim: true,
    uppercase: true
  },
  description: {
    type: String
  },
  parent_department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    default: null
  },
  head_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  head_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  budget_allocation: {
    type: Number,
    default: 0
  },
  employee_count: {
    type: Number,
    default: 0
  },
  is_active: {
    type: Boolean,
    default: true
  },
  settings: {
    color: String,
    icon: String
  }
}, {
  timestamps: true,
  collection: 'departments'
});

departmentSchema.index({ org_id: 1, name: 1 }, { unique: true });
departmentSchema.index({ org_id: 1, code: 1 }, { unique: true, sparse: true });
departmentSchema.index({ org_id: 1, parent_department_id: 1 });

export default departmentSchema;
