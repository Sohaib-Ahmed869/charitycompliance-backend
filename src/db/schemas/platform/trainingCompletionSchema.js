/**
 * Training Completion Schema (Tenant DB)
 * Per-resource completion for an enrollment
 */

import mongoose from 'mongoose';

const trainingCompletionSchema = new mongoose.Schema({
  enrollment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingEnrollment',
    required: true,
    index: true
  },
  resource_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingResource',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'completed'],
    default: 'not_started',
    index: true
  },
  completed_at: { type: Date },
  evidence_url: { type: String },
  /** Base64 data URL of digital signature (e.g. from canvas) */
  signature_data: { type: String },
  /** Video: seconds watched (for progress tracking) */
  video_seconds_watched: { type: Number, default: 0 },
  /** PDF/link: approximate percent read (0–100) */
  pdf_percent_read: { type: Number, default: 0, min: 0, max: 100 }
}, {
  timestamps: true,
  collection: 'training_completions'
});

trainingCompletionSchema.index({ enrollment_id: 1, resource_id: 1 }, { unique: true });

export default trainingCompletionSchema;
