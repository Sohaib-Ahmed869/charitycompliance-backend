/**
 * User Position Schema (Tenant DB)
 * 
 * Links users to positions within departments
 * This is the CRITICAL missing piece for the approval workflow
 */

import mongoose from 'mongoose';

const userPositionSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    required: true,
    index: true
  },
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
    index: true
  },
  effective_from: {
    type: Date,
    default: Date.now
  },
  effective_to: {
    type: Date,
    default: null
  },
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },
  assigned_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assigned_at: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String
  }
}, {
  timestamps: true,
  collection: 'user_positions'
});

// Indexes for efficient queries
userPositionSchema.index({ user_id: 1, is_active: 1 });
userPositionSchema.index({ position_id: 1, is_active: 1 });
userPositionSchema.index({ department_id: 1, is_active: 1 });
userPositionSchema.index({ org_id: 1, user_id: 1, position_id: 1 });
userPositionSchema.index({ org_id: 1, position_id: 1, is_active: 1 });

export default userPositionSchema;
