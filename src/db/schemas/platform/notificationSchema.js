/**
 * Notification Schema (Tenant DB)
 *
 * Stores in-app notifications for users (workflow approved, etc.)
 */

import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['workflow_approved', 'workflow_rejected', 'approval_pending', 'meeting_invitation', 'meeting_notes_added', 'ticket_assigned', 'authority_transfer_revoked', 'authority_transfer_assigned'],
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String
  },
  link: {
    type: String
  },
  related_entity_id: {
    type: mongoose.Schema.Types.ObjectId
  },
  related_entity_type: {
    type: String
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { timestamps: true });

notificationSchema.index({ user_id: 1, created_at: -1 });

export default notificationSchema;
