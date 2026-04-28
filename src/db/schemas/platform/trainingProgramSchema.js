/**
 * Training Program Schema (Tenant DB)
 * Top-level training (e.g. "Safeguarding & Child Protection Training")
 */

import mongoose from 'mongoose';

const resourceProgressSchema = new mongoose.Schema({
  resource_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: {
    type: String,
    enum: ['not_started', 'in_progress', 'completed'],
    default: 'not_started'
  },
  completed_at: { type: Date },
  evidence_url: { type: String },
  signature_data: { type: String },
  video_seconds_watched: { type: Number, default: 0 },
  pdf_percent_read: { type: Number, default: 0, min: 0, max: 100 },
  time_spent_seconds: { type: Number, default: 0 },
  started_at: { type: Date },
  last_activity_at: { type: Date }
}, { _id: false });

const enrollmentSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
  enrollment_type: { type: String, enum: ['internal', 'external'], default: 'internal', index: true },
  board_member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BoardMember', index: true, default: null },
  email: { type: String, lowercase: true, trim: true, default: null },
  name: { type: String, trim: true, default: null },
  token: { type: String, default: null },
  org_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  org_key: { type: String, default: null },
  status: {
    type: String,
    enum: ['assigned', 'not_started', 'in_progress', 'completed'],
    default: 'not_started'
  },
  enrolled_at: { type: Date, default: Date.now },
  started_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
  last_accessed_at: { type: Date, default: null },
  post_training_survey: {
    rating: { type: Number, min: 1, max: 5 },
    clarity: { type: String, enum: ['very_clear', 'somewhat_clear', 'confusing'], default: undefined },
    relevance: { type: String, enum: ['very_relevant', 'somewhat_relevant', 'not_relevant'], default: undefined },
    comments: { type: String },
    completed_at: { type: Date }
  },
  completions: { type: [resourceProgressSchema], default: [] },
  progress: { type: [resourceProgressSchema], default: [] },
  metadata: {
    invited_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recipient_type: { type: String, default: null },
    board_member_id: { type: String, default: null },
    donor_id: { type: String, default: null }
  }
}, { _id: false });

const resourceSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['pdf', 'video', 'link', 'image'], default: 'pdf' },
  file_url: { type: String, default: null },
  link_url: { type: String, default: null },
  cover_image_url: { type: String, default: null },
  order: { type: Number, default: 0 },
  estimated_minutes: { type: Number, default: 0 }
}, { _id: false });

const moduleSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  order: { type: Number, default: 0 },
  resources: { type: [resourceSchema], default: [] }
}, { _id: false });

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
  store_evidence: { type: Boolean, default: false },
  modules: { type: [moduleSchema], default: [] },
  enrollments: { type: [enrollmentSchema], default: [] }
}, {
  timestamps: true,
  collection: 'trainings'
});

trainingProgramSchema.index({ org_id: 1, status: 1 });
trainingProgramSchema.index({ 'enrollments.token': 1 }, { sparse: true });
trainingProgramSchema.index({ 'enrollments.board_member_id': 1 });

export default trainingProgramSchema;
