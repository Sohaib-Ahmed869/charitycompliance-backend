/**
 * Chat Channel Membership (Tenant DB)
 *
 * Many-to-many between users and channels. We materialise membership rather
 * than computing it on the fly because:
 *  - DMs need explicit membership (only the two participants).
 *  - Department channels need it for departments-of-departments / cross-department members.
 *  - last_read_at lives here so unread counts are a simple compare.
 */

import mongoose from 'mongoose';

const chatChannelMembershipSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  channel_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatChannel',
    required: true,
    index: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  /** Channel-scoped notification preference. Stub for Phase 2. */
  notify: {
    type: String,
    enum: ['all', 'mentions', 'muted'],
    default: 'all'
  },
  last_read_at: {
    type: Date,
    default: null
  },
  joined_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true, collection: 'chat_channel_memberships' });

chatChannelMembershipSchema.index({ channel_id: 1, user_id: 1 }, { unique: true });
chatChannelMembershipSchema.index({ org_id: 1, user_id: 1 });

export default chatChannelMembershipSchema;
