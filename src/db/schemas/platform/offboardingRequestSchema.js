import mongoose from 'mongoose';

const offboardingStepSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  completed: { type: Boolean, default: false },
  completed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completed_at: { type: Date, default: null },
  notes: { type: String, trim: true, default: '' },
  override_reason: { type: String, trim: true, default: '' }
}, { _id: true });

const offboardingRequestSchema = new mongoose.Schema({
  org_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  initiated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['in_progress', 'completed', 'cancelled'], default: 'in_progress', index: true },
  mfa_required: { type: Boolean, default: true },
  steps: { type: [offboardingStepSchema], default: [] },
  completed_at: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true,
  collection: 'offboarding_requests'
});

offboardingRequestSchema.index({ org_id: 1, user_id: 1, createdAt: -1 });

export default offboardingRequestSchema;
