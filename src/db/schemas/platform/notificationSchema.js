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
    enum: [
      'workflow_approved',
      'workflow_rejected',
      'approval_pending',
      'returned_for_resubmission',
      'meeting_invitation',
      'meeting_notes_added',
      'ticket_assigned',
      'authority_transfer_revoked',
      'authority_transfer_assigned',
      // Expenses
      'expense_payment_assignment_required',
      'expense_payment_assigned',
      'expense_payment_processing_assigned',
      'expense_payment_review_required',
      'expense_payment_completed',
      // Complaints
      'complaint_assigned',
      'complaint_workflow_assigned',
      'complaint_board_signoff_selected',
      'complaint_board_signoff_required',
      'complaint_escalated',
      // Registration & Licenses
      'registration_license_expiry_reminder',
      // Training
      'training_assigned',
      // Grants & Donors
      'project_deadline_required',
      // Project handoff / delivery
      'project_refund_partner_receipts_required',
      'project_delivery_changes_partner_explanation_required',
      'project_refund_partner_receipts_submitted',
      'project_delivery_changes_partner_explanation_submitted',
      'project_delivery_documents_required',
      'project_delivery_workflow_started',
      // Generic reminders
      'reminder_expiring',
      'reminder_overdue',
      'reminder_meeting',
      'reminder_escalated_dept_head',
      'reminder_escalated_board'
    ],
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
