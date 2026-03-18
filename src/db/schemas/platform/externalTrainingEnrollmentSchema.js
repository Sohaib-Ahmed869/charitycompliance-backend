/**
 * External Training Enrollment Schema (Tenant DB)
 * Allows external participants (no portal login) to complete training via token link.
 */

import mongoose from 'mongoose';

const externalTrainingProgressSchema = new mongoose.Schema(
  {
    resource_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainingResource', required: true },
    status: { type: String, enum: ['not_started', 'in_progress', 'completed'], default: 'not_started' },
    video_seconds_watched: { type: Number, default: 0, min: 0 },
    pdf_percent_read: { type: Number, default: 0, min: 0, max: 100 },
    time_spent_seconds: { type: Number, default: 0, min: 0 },
    started_at: { type: Date, default: null },
    last_activity_at: { type: Date, default: null },
    signature_data: { type: String, default: null },
    completed_at: { type: Date, default: null }
  },
  { _id: false }
);

const externalTrainingEnrollmentSchema = new mongoose.Schema(
  {
    // orgId string used by tenantResolver/getTenantConnection
    org_key: { type: String, required: true, index: true },
    org_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    training_program_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainingProgram', required: true, index: true },

    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    name: { type: String, trim: true, default: '' },

    token: { type: String, required: true, unique: true, index: true },

    status: { type: String, enum: ['not_started', 'in_progress', 'completed'], default: 'not_started', index: true },
    enrolled_at: { type: Date, default: Date.now },
    started_at: { type: Date, default: null },
    last_accessed_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },

    progress: { type: [externalTrainingProgressSchema], default: [] },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true, collection: 'external_training_enrollments' }
);

externalTrainingEnrollmentSchema.index({ training_program_id: 1, email: 1 }, { unique: true });

export default externalTrainingEnrollmentSchema;

