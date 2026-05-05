/**
 * Chat Message Read Receipt (Tenant DB)
 *
 * One row per (user, message) the moment a user marks a message read.
 * Distinct from the membership-level `last_read_at` which only tracks unread
 * counts at the channel level — these rows answer "who has actually seen
 * this specific message?".
 */

import mongoose from 'mongoose';

const chatMessageReadSchema = new mongoose.Schema({
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
  },
  read_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true, collection: 'chat_message_reads' });

chatMessageReadSchema.index({ user_id: 1, message_id: 1 }, { unique: true });
chatMessageReadSchema.index({ message_id: 1 });

export default chatMessageReadSchema;
