/**
 * Training Enrollment Schema (Tenant DB)
 * Links a person (board member) to a training program
 */

import mongoose from 'mongoose';

const trainingEnrollmentSchema = new mongoose.Schema({
  training_program_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingProgram',
    required: true,
    index: true
  },
  board_member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BoardMember',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['assigned', 'in_progress', 'completed'],
    default: 'assigned',
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
  }
}, {
  timestamps: true,
  collection: 'training_enrollments'
});

trainingEnrollmentSchema.index({ training_program_id: 1, board_member_id: 1 }, { unique: true });
trainingEnrollmentSchema.index({ board_member_id: 1 });

export default trainingEnrollmentSchema;
