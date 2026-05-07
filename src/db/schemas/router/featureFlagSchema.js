/**
 * Feature Flag Catalogue (Router DB)
 *
 * Defines every gateable capability in Stewardex. Each Plan grants a subset
 * by setting `feature_flags[code] = true`. Managed by SuperAdmin from the
 * /calcite-admin/feature-flags screen; flags can be deprecated once a Plan
 * references them but never deleted, so historical revisions stay valid.
 */

import mongoose from 'mongoose';

const featureFlagSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
    // e.g. 'finance.expense_workflow'
  },
  category: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
    // 'governance' | 'security' | 'finance' | 'partner' | 'people' | …
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: '',
    trim: true
  },
  status: {
    type: String,
    enum: ['active', 'deprecated'],
    default: 'active',
    index: true
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'feature_flags'
});

featureFlagSchema.index({ category: 1, code: 1 });

export default featureFlagSchema;
