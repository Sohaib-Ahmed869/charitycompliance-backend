/**
 * Asset Schema (Tenant DB)
 * 
 * IT assets and equipment tracking
 */

import mongoose from 'mongoose';

const assetSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  asset_name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  category: {
    type: String,
    enum: ['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Other'],
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    trim: true
  },
  vendor_name: {
    type: String,
    trim: true
  },
  model: {
    type: String,
    trim: true
  },
  serial_number: {
    type: String,
    trim: true
  },
  processor: {
    type: String,
    trim: true
  },
  ram: {
    type: String,
    trim: true
  },
  storage: {
    type: String,
    trim: true
  },
  worth: {
    type: Number,
    required: true,
    min: 0
  },
  purchase_date: {
    type: Date,
    required: true
  },
  maintenance_date: {
    type: Date
  },
  department_owner: {
    type: String,
    trim: true
  },
  assigned_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance', 'retired'],
    default: 'active',
    index: true
  },
  documentation: {
    type: String
  },
  documentation_file_name: {
    type: String
  },
  notes: {
    type: String
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'assets'
});

assetSchema.index({ org_id: 1, status: 1 });
assetSchema.index({ org_id: 1, created_at: -1 });
assetSchema.index({ org_id: 1, category: 1 });

export default assetSchema;
