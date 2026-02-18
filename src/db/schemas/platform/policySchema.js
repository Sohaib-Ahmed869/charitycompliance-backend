/**
 * Policy Schema (Tenant DB)
 *
 * Organizational policies and procedures
 */

import mongoose from 'mongoose';

const policySchema = new mongoose.Schema(
  {
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    description: {
      type: String
    },
    policy_owner_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BoardMember',
      sparse: true
    },
    /** Department ref for approval workflow (department head as first approver) */
    department_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      index: true
    },
    department: {
      type: String,
      trim: true
    },
    effective_date: {
      type: Date
    },
    review_cycle: {
      type: String,
      enum: ['3 months', '6 months', '12 months', '24 months', 'other'],
      default: '12 months'
    },
    review_date: {
      type: Date
    },
    next_review_date: {
      type: Date
    },
    is_under_review: {
      type: Boolean,
      default: false,
      index: true
    },
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true
    },
    reviewed_by_name: {
      type: String
    },
    reviewed_at: {
      type: Date,
      sparse: true
    },
    review_history: [
      {
        reviewed_by: {
          type: mongoose.Schema.Types.ObjectId,
          required: true
        },
        reviewed_by_name: {
          type: String
        },
        reviewed_by_title: {
          type: String
        },
        reviewed_at: {
          type: Date,
          required: true,
          default: Date.now
        },
        action: {
          type: String,
          enum: ['approved_no_changes', 'updated', 'rejected'],
          required: true
        },
        comments: {
          type: String,
          trim: true
        },
        version_reviewed: {
          type: String
        },
        next_review_date_set: {
          type: Date
        },
        e_signature: {
          type: String
        },
        approver_name: {
          type: String
        }
      }
    ],
    acknowledgements: [
      {
        acknowledged_by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true
        },
        acknowledged_at: {
          type: Date,
          required: true,
          default: Date.now
        }
      }
    ],
    file_name: {
      type: String
    },
    file_path: {
      type: String
    },
    file_size: {
      type: Number
    },
    mime_type: {
      type: String
    },
    version: {
      type: String,
      default: 'v1.0'
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'under_review', 'expired'],
      default: 'draft',
      index: true
    },
    uploaded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    approval_matrix_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApprovalMatrix'
    },
    approval_request_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApprovalRequest'
    }
  },
  {
    timestamps: true,
    collection: 'policies'
  }
);

policySchema.index({ org_id: 1, category: 1 });
policySchema.index({ org_id: 1, status: 1 });

export default policySchema;
