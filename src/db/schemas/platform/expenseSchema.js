/**
 * Expense Schema (Tenant DB)
 * 
 * Expenses/Invoices submitted for approval
 */

import mongoose from 'mongoose';

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
    required: true,
    trim: true
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
  vendor_email: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'rejected', 'paid', 'cancelled'],
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
