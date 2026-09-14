/**
 * Supplier Schema (Tenant DB)
 *
 * The Supplier Register holds vendor / contractor / service-provider records
 * that need a vetting workflow before they can be picked on an expense form.
 *
 * Lifecycle:
 *   draft → pending_review → approved   ↘
 *                          ↘ rejected    │
 *                                        │── only `approved` + `is_active` +
 *                                        │   not-expired suppliers appear in
 *                                        │   the expense form dropdown
 *
 * Encryption posture: ABN, ACN, contact email/phone, and the bank account
 * sub-doc are field-level encrypted via the mongooseEncryptPlugin. ABN and
 * contact email also get `searchable: true` so the typeahead can equality-
 * match on them through a blind index.
 */

import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema({
  line1: { type: String, trim: true },
  line2: { type: String, trim: true },
  suburb: { type: String, trim: true },
  state: { type: String, trim: true },
  postcode: { type: String, trim: true },
  country: { type: String, trim: true, default: 'Australia' }
}, { _id: false });

const bankAccountSchema = new mongoose.Schema({
  account_name: { type: String, trim: true, encrypted: true },
  bsb:          { type: String, trim: true, encrypted: true },
  account_number: { type: String, trim: true, encrypted: true }
}, { _id: false });

const supplierSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  // Human-readable code (SUP-2026-0184). Auto-generated server-side on
  // create if blank. Unique per-org via the compound index below.
  supplier_number: {
    type: String,
    trim: true,
    required: true
  },

  legal_name:   { type: String, required: true, trim: true },
  trading_name: { type: String, trim: true },

  abn: { type: String, trim: true, encrypted: true, searchable: true },
  acn: { type: String, trim: true, encrypted: true },

  contact_name:  { type: String, trim: true },
  contact_email: { type: String, trim: true, encrypted: true, searchable: true },
  contact_phone: { type: String, trim: true, encrypted: true },

  address: addressSchema,

  category: {
    type: String,
    enum: ['goods', 'services', 'professional', 'utility', 'contractor', 'other'],
    default: 'goods',
    index: true
  },

  payment_terms: {
    type: String,
    enum: ['net_7', 'net_14', 'net_30', 'net_60', 'prepaid', 'cod'],
    default: 'net_30'
  },

  bank_account: bankAccountSchema,

  gst_registered: { type: Boolean, default: false },
  default_currency: { type: String, default: 'AUD', trim: true },

  // Soft-disable without losing history. Inactive suppliers vanish from
  // the expense-form dropdown but the linked expenses still resolve.
  is_active: { type: Boolean, default: true, index: true },

  tags: [{ type: String, trim: true }],
  notes: { type: String, trim: true },

  // ─── Vetting workflow fields ─────────────────────────────────────────
  vetting_status: {
    type: String,
    enum: ['draft', 'pending_review', 'approved', 'rejected'],
    default: 'draft',
    index: true
  },
  vetted_at: { type: Date },
  vetted_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejection_reason: { type: String, trim: true },

  // Optional re-vetting cadence. When `expires_at` is past, the supplier
  // auto-drops from the dropdown until re-approved. Calendar surfaces
  // expiring suppliers using the shared expiry-window constant (90 days).
  expires_at: { type: Date, index: true },

  risk_rating: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },

  // One-to-one with the active workflow run. Same pattern as COI /
  // partner vetting — when this is set, the supplier's vetting_status
  // mirrors the workflow's overall status.
  approval_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest' },

  // Vetting evidence (insurance certs, ABN extract, contracts ...).
  // Either an embedded record or a pointer into the Document collection;
  // we keep it embedded here for read locality.
  documents: [{
    document_type: { type: String, trim: true },
    name:          { type: String, trim: true },
    file_path:     { type: String, trim: true },
    file_name:     { type: String, trim: true },
    uploaded_at:   { type: Date, default: Date.now },
    uploaded_by:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],

  // Stamp who created / last touched the record.
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true,
  collection: 'suppliers'
});

// Per-org uniqueness on the human-readable code. The same number could
// repeat across different tenants; the org_id partition keeps it scoped.
supplierSchema.index({ org_id: 1, supplier_number: 1 }, { unique: true });

// Composite hit for the expense-form dropdown: only approved + active
// + not-expired records bubble up.
supplierSchema.index({ org_id: 1, vetting_status: 1, is_active: 1, expires_at: 1 });

// For the register list page's sort-by-recent default.
supplierSchema.index({ org_id: 1, createdAt: -1 });

export default supplierSchema;
