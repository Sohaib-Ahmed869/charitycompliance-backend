/**
 * Chat Message (Tenant DB)
 *
 * One document per posted message. Soft-delete only — full history is
 * retained for audit (the `is_deleted` flag and `edits` history are the
 * audit trail). Compliance mentions, attachments, and parent_message_id
 * are stub fields for Phase 2; Phase 1 only writes body + sender.
 */

import mongoose from 'mongoose';

const messageEditSchema = new mongoose.Schema({
  body: { type: String, required: true },
  edited_at: { type: Date, default: Date.now }
}, { _id: false });

const complianceMentionSchema = new mongoose.Schema({
  /** e.g. 'policy', 'workflow', 'expense', 'meeting', 'coi'. */
  entity_type: { type: String, required: true },
  entity_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  /** Snapshot of label at mention time so the chip survives entity rename. */
  label: { type: String, default: '' }
}, { _id: false });

const attachmentSchema = new mongoose.Schema({
  s3_key: { type: String, required: true },
  filename: { type: String, default: '' },
  mime_type: { type: String, default: '' },
  size_bytes: { type: Number, default: 0 }
}, { _id: false });

/** One row per distinct emoji on a message; user_ids holds everyone who reacted with it. */
const reactionSchema = new mongoose.Schema({
  emoji: { type: String, required: true },
  user_ids: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] }
}, { _id: false });

const chatMessageSchema = new mongoose.Schema({
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
  sender_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  body: {
    type: String,
    default: ''
  },
  /** For threaded replies — Phase 2. */
  parent_message_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatMessage',
    default: null,
    index: true
  },
  /** For inline reply quoting (different from threading). */
  reply_to_message_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatMessage',
    default: null
  },
  mentioned_user_ids: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'User',
    default: []
  },
  compliance_mentions: {
    type: [complianceMentionSchema],
    default: []
  },
  attachments: {
    type: [attachmentSchema],
    default: []
  },
  is_pinned: {
    type: Boolean,
    default: false,
    index: true
  },
  pinned_at: {
    type: Date,
    default: null
  },
  pinned_by_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reactions: {
    type: [reactionSchema],
    default: []
  },
  is_deleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deleted_at: {
    type: Date,
    default: null
  },
  /** History of prior bodies — present whenever the user has edited. */
  edits: {
    type: [messageEditSchema],
    default: []
  },
  /** Cached count of replies in this message's thread (only meaningful for parent messages). */
  thread_reply_count: {
    type: Number,
    default: 0
  }
}, { timestamps: true, collection: 'chat_messages' });

chatMessageSchema.index({ channel_id: 1, createdAt: -1 });
chatMessageSchema.index({ channel_id: 1, parent_message_id: 1, createdAt: 1 });

export default chatMessageSchema;
