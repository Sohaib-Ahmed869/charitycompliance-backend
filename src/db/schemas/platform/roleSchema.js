/**
 * Role Schema (Tenant DB)
 * 
 * Role definitions with permissions
 */

import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  display_name: {
    type: String,
    required: true,
    trim: true
  },
  permissions: {
    type: [String],
    default: []
  },
  is_readonly: {
    type: Boolean,
    default: false
  },
  is_system: {
    type: Boolean,
    default: false
  },
  description: {
    type: String
  }
}, {
  timestamps: true,
  collection: 'roles'
});

roleSchema.index({ name: 1 }, { unique: true });

export default roleSchema;
