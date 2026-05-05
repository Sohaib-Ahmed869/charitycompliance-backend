/**
 * Chat Mention Digest Log (Tenant DB)
 *
 * Records that a specific (user, message) mention has been emailed in a digest
 * so the same mention is never digested twice.
 */

import mongoose from 'mongoose';

const chatMentionDigestLogSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',        required: true },
  message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', required: true },
  sent_at:    { type: Date, default: Date.now }
}, { timestamps: true, collection: 'chat_mention_digest_logs' });

chatMentionDigestLogSchema.index({ user_id: 1, message_id: 1 }, { unique: true });

export default chatMentionDigestLogSchema;
