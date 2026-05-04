/**
 * Chat Message Star (Tenant DB)
 *
 * Per-user personal bookmark on a message. Distinct from `is_pinned` which
 * is a channel-wide pin set by an admin.
 */

import mongoose from 'mongoose';

const chatMessageStarSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  message_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatMessage',
    required: true,
    index: true
  },
  channel_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatChannel',
    required: true
  }
}, { timestamps: true, collection: 'chat_message_stars' });

chatMessageStarSchema.index({ user_id: 1, message_id: 1 }, { unique: true });
chatMessageStarSchema.index({ user_id: 1, createdAt: -1 });

export default chatMessageStarSchema;
