/**
 * User Role Schema (Tenant DB)
 * 
 * Links users to roles with optional department scoping
 */

import mongoose from 'mongoose';

const userRoleSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  role_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    required: true,
    index: true
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    index: true,
    sparse: true
  },
  effective_from: {
    type: Date,
    default: Date.now
  },
  effective_to: {
    type: Date
  },
  is_active: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true,
  collection: 'user_roles'
});

userRoleSchema.index({ user_id: 1, role_id: 1 });
userRoleSchema.index({ user_id: 1, is_active: 1 });
userRoleSchema.index({ department_id: 1, is_active: 1 });

export default userRoleSchema;
