/**
 * Tenant Schema (Router DB)
 * 
 * Stores tenant routing information - which Pod/cluster hosts each organization
 */

import mongoose from 'mongoose';

const tenantSchema = new mongoose.Schema({
  orgId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
  },
  clusterEndpoint: {
    type: String,
    required: true
  },
  dbName: {
    type: String,
    required: true,
    trim: true
  },
  encryptedDataKey: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'tenants'
});

tenantSchema.index({ orgId: 1 }, { unique: true });
tenantSchema.index({ status: 1 });

export default tenantSchema;
