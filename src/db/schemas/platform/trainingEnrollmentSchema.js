/**
 * Training Enrollment Schema (Tenant DB)
 * Links a person (board member) to a training program
 */

import mongoose from 'mongoose';

const completionItemSchema = new mongoose.Schema({
  resource_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingResource',
    required: true
  },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'completed'],
    default: 'not_started'
  },
  completed_at: { type: Date },
  evidence_url: { type: String },
  signature_data: { type: String },
  video_seconds_watched: { type: Number, default: 0 },
  pdf_percent_read: { type: Number, default: 0, min: 0, max: 100 }
}, { _id: true });

const externalProgressSchema = new mongoose.Schema({
  resource_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingResource',
    required: true
  },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'completed'],
    default: 'not_started'
  },
  video_seconds_watched: { type: Number, default: 0 },
  pdf_percent_read: { type: Number, default: 0, min: 0, max: 100 },
  time_spent_seconds: { type: Number, default: 0 },
  started_at: { type: Date },
  last_activity_at: { type: Date },
  signature_data: { type: String },
  completed_at: { type: Date }
}, { _id: false });

const trainingEnrollmentSchema = new mongoose.Schema({
  enrollment_type: {
    type: String,
    enum: ['internal', 'external'],
    default: 'internal',
    index: true
  },
  training_program_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingProgram',
    required: true,
    index: true
  },
  board_member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BoardMember',
    index: true
  },
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    index: true
  },
  org_key: { type: String },
  email: { type: String, lowercase: true, trim: true },
  name: { type: String, trim: true },
  token: { type: String, index: true },
  status: {
    type: String,
    enum: ['assigned', 'not_started', 'in_progress', 'completed'],
    default: 'not_started',
    index: true
  },
  enrolled_at: {
    type: Date,
    default: Date.now
  },
  completed_at: { type: Date },
  /** Optional post-training survey filled by the participant */
  post_training_survey: {
    rating: { type: Number, min: 1, max: 5 },
    clarity: { type: String, enum: ['very_clear', 'somewhat_clear', 'confusing'], default: undefined },
    relevance: { type: String, enum: ['very_relevant', 'somewhat_relevant', 'not_relevant'], default: undefined },
    comments: { type: String },
    completed_at: { type: Date }
  },
  completions: { type: [completionItemSchema], default: [] },
  progress: { type: [externalProgressSchema], default: [] },
  started_at: { type: Date },
  last_accessed_at: { type: Date },
  metadata: {
    invited_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recipient_type: { type: String, default: null },
    board_member_id: { type: String, default: null },
    donor_id: { type: String, default: null }
  }
}, {
  timestamps: true,
  collection: 'training_enrollments'
});

trainingEnrollmentSchema.index(
  { training_program_id: 1, board_member_id: 1 },
  {
    unique: true,
    partialFilterExpression: { enrollment_type: 'internal', board_member_id: { $exists: true } }
  }
);
trainingEnrollmentSchema.index(
  { training_program_id: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { enrollment_type: 'external', email: { $type: 'string' } }
  }
);
trainingEnrollmentSchema.index({ board_member_id: 1 });
trainingEnrollmentSchema.index({ org_id: 1, enrollment_type: 1 });
trainingEnrollmentSchema.index({ token: 1 }, { sparse: true, unique: true });

export default trainingEnrollmentSchema;
