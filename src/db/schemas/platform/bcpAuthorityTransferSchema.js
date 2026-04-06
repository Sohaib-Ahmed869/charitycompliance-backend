/**
 * BCP Authority Transfer Schema
 * 
 * Records authority transfers between positions/departments
 * for governance and regulatory matters
 */

import mongoose from 'mongoose';

const bcpAuthorityTransferSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  transfer_code: {
    type: String,
    unique: true
  },
  
  // From
  from_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  from_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    required: true
  },
  from_department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true
  },
  
  // To
  to_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  to_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    required: true
  },
  to_department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: true
  },

  workflow_matrix_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalMatrix'
  },
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest'
  },
  
  transfer_type: {
    type: String,
    enum: ['temporary', 'permanent', 'emergency'],
    required: true
  },
  
  reason: {
    type: String,
    enum: ['leave', 'resignation', 'termination', 'illness', 'emergency', 'restructure', 'other'],
    required: true
  },
  reason_details: {
    type: String
  },
  
  authorities_transferred: [{
    authority: {
      type: String,
      enum: ['signatory', 'approval', 'regulatory_access', 'system_access', 'legal_representation', 'financial_control', 'other']
    },
    description: String,
    limitations: String
  }],
  
  effective_date: {
    type: Date,
    required: true
  },
  end_date: {
    type: Date
  },
  
  status: {
    type: String,
    enum: ['pending', 'active', 'completed', 'revoked', 'resubmission_required'],
    default: 'pending'
  },
  
  // Approval workflow
  requires_trustee_approval: {
    type: Boolean,
    default: true
  },
  approvals: [{
    approver_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    role: {
      type: String,
      enum: ['manager', 'hr', 'trustee', 'workflow']
    },
    approved: Boolean,
    comments: String,
    approved_at: Date
  }],
  
  // Verification
  identity_verified: {
    type: Boolean,
    default: false
  },
  verification_method: String,
  verified_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  verified_at: Date,
  
  // Supporting documents
  attachments: [{
    filename: String,
    filepath: String,
    document_type: String,
    uploaded_at: { type: Date, default: Date.now },
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  
  // Audit
  handover_checklist: [{
    item: String,
    completed: Boolean,
    completed_at: Date,
    notes: String
  }],
  
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Generate transfer code before save
bcpAuthorityTransferSchema.pre('save', async function(next) {
  if (!this.transfer_code) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.transfer_code = `ATR-${year}${month}-${random}`;
  }
  next();
});

bcpAuthorityTransferSchema.index({ org_id: 1, status: 1 });
bcpAuthorityTransferSchema.index({ org_id: 1, effective_date: 1, end_date: 1 });

export default bcpAuthorityTransferSchema;
