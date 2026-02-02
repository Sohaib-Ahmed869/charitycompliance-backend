/**
 * Training Module Schema (Tenant DB)
 * Section within a training program (e.g. "Introduction to Safeguarding")
 */

import mongoose from 'mongoose';

const trainingModuleSchema = new mongoose.Schema({
  training_program_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingProgram',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true,
  collection: 'training_modules'
});

trainingModuleSchema.index({ training_program_id: 1, order: 1 });

export default trainingModuleSchema;
