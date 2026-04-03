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
