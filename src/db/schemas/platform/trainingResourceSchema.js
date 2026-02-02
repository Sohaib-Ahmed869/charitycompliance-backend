/**
 * Training Resource Schema (Tenant DB)
 * Single resource within a module (PDF, Video, Link)
 */

import mongoose from 'mongoose';

const trainingResourceSchema = new mongoose.Schema({
  module_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingModule',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['pdf', 'video', 'link'],
    default: 'pdf'
  },
  file_url: { type: String },
  link_url: { type: String },
  cover_image_url: { type: String },
  order: {
    type: Number,
    default: 0
  },
  estimated_minutes: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true,
  collection: 'training_resources'
});

trainingResourceSchema.index({ module_id: 1, order: 1 });

export default trainingResourceSchema;
