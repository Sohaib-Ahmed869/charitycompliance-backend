/**
 * Member Schema (Tenant DB)
 *
 * The Members Register keeps basic records of an organisation's members —
 * name, contact details, membership type and join date.
 *
 * Approval posture: a member is `approved` on create UNLESS the org has a
 * "Member Approvals" (members_approval) workflow configured — in which case
 * the member starts `pending_approval`, an ApprovalRequest is spawned, and the
 * status flips to `approved` / `rejected` when the workflow settles.
 *
 * Encryption posture: email and phone are field-level encrypted via the
 * mongooseEncryptPlugin; email is also `searchable` so equality lookups work
 * through a blind index. full_name stays plaintext so the register list can
 * do case-insensitive partial-name search.
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../../../utils/mongooseEncryptPlugin.js';

const addressSchema = new mongoose.Schema({
  line1: { type: String, trim: true },
  line2: { type: String, trim: true },
  suburb: { type: String, trim: true },
  state: { type: String, trim: true },
  postcode: { type: String, trim: true },
  country: { type: String, trim: true, default: 'Australia' }
}, { _id: false });

const memberSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  // Human-readable code (MEM-2026-0042). Auto-generated server-side on
  // create when blank. Unique per-org via the compound index below.
  member_number: { type: String, trim: true, required: true },

  full_name: { type: String, required: true, trim: true },

  email: { type: String, trim: true, encrypted: true, searchable: true },
  phone: { type: String, trim: true, encrypted: true },

  address: addressSchema,

  membership_type: {
    type: String,
    enum: ['individual', 'organisation', 'life', 'honorary', 'student', 'associate', 'other'],
    default: 'individual',
    index: true
  },

  date_joined: { type: Date },

  // Soft-disable without losing history.
  is_active: { type: Boolean, default: true, index: true },

  tags: [{ type: String, trim: true }],
  notes: { type: String, trim: true },

  // ─── Approval lifecycle ──────────────────────────────────────────────
  // Default `approved`: members are approved on create unless a
  // members_approval workflow is configured, in which case the controller
  // sets `pending_approval` and links the workflow run below.
  status: {
    type: String,
    enum: ['approved', 'pending_approval', 'rejected'],
    default: 'approved',
    index: true
  },
  approval_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },
  approved_at: { type: Date },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejection_reason: { type: String, trim: true },

  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true,
  collection: 'members'
});

memberSchema.index({ org_id: 1, member_number: 1 }, { unique: true });
memberSchema.index({ org_id: 1, status: 1, is_active: 1 });
memberSchema.index({ org_id: 1, createdAt: -1 });

// Field-level encryption for the PII fields marked `encrypted: true`.
memberSchema.plugin(mongooseEncryptPlugin);

export default memberSchema;
