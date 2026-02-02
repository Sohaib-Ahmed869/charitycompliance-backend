/**
 * Training Program Schema (Tenant DB)
 * Top-level training (e.g. "Safeguarding & Child Protection Training")
 */

import mongoose from 'mongoose';

const trainingProgramSchema = new mongoose.Schema({
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
  category: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  expires: {
    type: Boolean,
    default: false
  },
  renewal_months: {
    type: Number,
    default: 12
  },
  status: {
    type: String,
    enum: ['draft', 'published'],
    default: 'draft',
    index: true
  },
  published_at: {
    type: Date
  },
  // Assignment: who must complete this training
  department_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
  position_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Position' }],
  track_completion_status: { type: Boolean, default: true },
  record_completion_dates: { type: Boolean, default: true },
  store_evidence: { type: Boolean, default: false }
}, {
  timestamps: true,
  collection: 'training_programs'
});

trainingProgramSchema.index({ org_id: 1, status: 1 });

export default trainingProgramSchema;
