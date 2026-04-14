/**
 * Expense Schema (Tenant DB)
 * 
 * Expenses/Invoices submitted for approval
 */

import mongoose from 'mongoose';

const paymentEntrySchema = new mongoose.Schema({
  amount: {
    type: Number,
    min: 0
  },
  payment_method: {
    type: String,
    trim: true
  },
  payment_proof: {
    type: String // S3 key
  },
  payment_proof_name: {
    type: String
  },
  payment_date: {
    type: Date
  },
  payment_reference: {
    type: String
  },
  payment_notes: {
    type: String
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  created_at: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const expenseSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  submitted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  expense_name: {
    type: String,
    trim: true,
    default: ''
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  invoice_file: {
    type: String, // File path/URL
    required: true
  },
  invoice_file_name: {
    type: String
  },
  invoice_date: {
    type: Date
  },
  vendor_name: {
    type: String,
    trim: true
  },
  supplier_name: {
    type: String,
    trim: true
  },
  supplier_information: {
    type: String,
    trim: true
  },
  vendor_email: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'rejected', 'resubmission_required', 'paid', 'cancelled'],
    default: 'draft',
    index: true
  },
  approval_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix'
  },
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  },
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectRegister',
    index: true
  },
  funding_agreement_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FundingAgreement',
    index: true
  },
  rejection_reason: {
    type: String
  },
  rejected_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejected_at: {
    type: Date
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  approved_at: {
    type: Date
  },
  paid_at: {
    type: Date
  },
  payment_reference: {
    type: String
  },
  assigned_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  // New: payment processing workflow (processor enters details, reviewer accepts)
  payment_processor_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  payment_reviewer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  /** Second signatory: approves first (no e-signature). Distinct from processor and signing reviewer. */
  payment_co_signatory_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  payment_initiated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  payment_proof_uploaded_at: {
    type: Date
  },
  payment_approval_status: {
    type: String,
    enum: ['none', 'proof_uploaded', 'pending_dual', 'released', 'rejected'],
    default: 'none',
    index: true
  },
  payment_return_reason: {
    type: String,
    trim: true
  },
  payment_dual_approval: {
    co_signatory: {
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'waived'],
        default: 'waived'
      },
      comment: { type: String, trim: true },
      acted_at: { type: Date }
    },
    signing_reviewer: {
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
      },
      comment: { type: String, trim: true },
      acted_at: { type: Date },
      signature_data: { type: String }
    }
  },
  payment_audit_log: {
    type: [
      {
        at: { type: Date, default: Date.now },
        user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        action: { type: String, trim: true },
        detail: { type: String, trim: true }
      }
    ],
    default: []
  },
  payment_stage: {
    type: String,
    enum: ['unassigned', 'processing', 'review', 'completed'],
    default: 'unassigned',
    index: true
  },
  payments: {
    type: [paymentEntrySchema],
    default: []
  },
  payment_review: {
    status: { type: String, enum: ['accepted', 'changes_requested'] },
    review_notes: { type: String },
    signature_data: { type: String }, // base64 data URL from DigitalSignature
    reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewed_at: { type: Date }
  },
  payment_compliance_checkpoint: {
    supplier_abn: { type: String, trim: true },
    abn_checksum_valid: { type: Boolean },
    gst_treatment: { type: String, trim: true },
    supplier_claims_tax_exempt: { type: Boolean },
    gst_consistent: { type: Boolean },
    expense_amount_snapshot: { type: Number },
    high_value_threshold_exceeded: { type: Boolean },
    high_value_acknowledged: { type: Boolean },
    compliance_status: {
      type: String,
      enum: ['verified', 'pending', 'failed']
    },
    manual_override: { type: Boolean },
    override_comment: { type: String },
    recorded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recorded_at: { type: Date }
  },
  payment_method: {
    type: String,
    trim: true
  },
  payment_proof: {
    type: String // File path/URL
  },
  payment_proof_name: {
    type: String
  },
  payment_date: {
    type: Date
  },
  payment_notes: {
    type: String
  },
  is_asset_purchase: {
    type: Boolean,
    default: false
  },
  asset_details: {
    asset_name: String,
    asset_category: String,
    asset_type: String,
    vendor_name: String,
    model: String,
    serial_number: String,
    processor: String,
    ram: String,
    storage: String,
    ownership_custodian: String,
    acquisition_details: String,
    evidence_attachment: String,
    evidence_attachment_name: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'expenses'
});

expenseSchema.index({ org_id: 1, status: 1 });
expenseSchema.index({ org_id: 1, submitted_by: 1 });
expenseSchema.index({ org_id: 1, created_at: -1 });
expenseSchema.index({ approval_request_id: 1 });

export default expenseSchema;
