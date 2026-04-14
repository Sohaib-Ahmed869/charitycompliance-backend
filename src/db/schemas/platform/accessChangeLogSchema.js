import mongoose from 'mongoose';

const accessChangeLogSchema = new mongoose.Schema({
  org_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  board_member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BoardMember', default: null },
  changed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true, trim: true },
  module: { type: String, default: 'offboarding', trim: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false,
  collection: 'access_change_logs'
});

accessChangeLogSchema.index({ org_id: 1, created_at: -1 });

export default accessChangeLogSchema;
