/**
 * Chat Channel Schema (Tenant DB)
 *
 * Conversational containers. Four kinds:
 *  - department: one per Department, only its members may post.
 *  - general:    auto-provisioned org-wide. Everyone can read; only admins can post.
 *  - announcements: auto-provisioned org-wide. Same posting rules as general.
 *  - dm:         private 1:1, member_user_ids has exactly two ids.
 *
 * Channels are auto-provisioned on first chat read for an org (general,
 * announcements, one per existing department). DMs are created on demand.
 */

import mongoose from 'mongoose';

const chatChannelSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  kind: {
    type: String,
    enum: ['department', 'general', 'announcements', 'dm', 'private'],
    required: true,
    index: true
  },
  /** Display name. Empty for DMs (resolved client-side from member names). */
  name: {
    type: String,
    trim: true,
    default: ''
  },
  description: {
    type: String,
    default: ''
  },
  /** For kind='department' only. */
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    default: null,
    index: true
  },
  /** For kind='dm' only — the two participants. */
  member_user_ids: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'User',
    default: []
  },
  /** Whether non-admins can send messages. False for general/announcements. */
  posting_open: {
    type: Boolean,
    default: true
  },
  /** Retention in days; 0 = retain forever. Stub for Phase 2 enforcement. */
  retention_days: {
    type: Number,
    default: 0
  },
  is_archived: {
    type: Boolean,
    default: false,
    index: true
  },
  last_message_at: {
    type: Date,
    default: null,
    index: true
  },
  created_by_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true, collection: 'chat_channels' });

// One general / announcements channel per org.
chatChannelSchema.index(
  { org_id: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: { $in: ['general', 'announcements'] } } }
);
// One channel per department.
chatChannelSchema.index(
  { org_id: 1, department_id: 1 },
  { unique: true, partialFilterExpression: { kind: 'department', department_id: { $type: 'objectId' } } }
);
chatChannelSchema.index({ org_id: 1, kind: 1, last_message_at: -1 });

export default chatChannelSchema;
