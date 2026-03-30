import mongoose from 'mongoose';

// Stores partner-submitted receipts/explanations for under-budget refunds.
const projectRefundSchema = new mongoose.Schema(
  {
    org_key: {
      type: String,
      required: true,
      index: true
    },
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    project_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectRegister',
      required: true,
      index: true
    },
    agreement_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FundingAgreement'
    },
    token: {
      type: String,
      required: true,
      index: true
    },
    refund_amount: {
      type: Number,
      default: 0,
      min: 0
    },
    admin_explanation: {
      type: String,
      default: ''
    },
    status: {
      type: String,
      enum: [
        'pending_initiation',
        'awaiting_partner_receipts',
        'partner_receipts_submitted',
        'internal_approved',
        'completed'
      ],
      default: 'pending_initiation',
      index: true
    },
    initiated_at: {
      type: Date
    },
    initiated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    partner_contact_email: {
      type: String,
      trim: true
    },
    partner_submission: {
      submitted_at: {
        type: Date
      },
      notes: {
        type: String,
        default: ''
      },
      receipts: [
        {
          file_name: { type: String, default: '' },
          data_url: { type: String, default: '' }
        }
      ]
    },
    internal_approval_request_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApprovalRequest'
    },
    internal_approved_at: {
      type: Date
    }
  },
  {
    timestamps: true,
    collection: 'project_refunds'
  }
);

projectRefundSchema.index({ org_key: 1, token: 1 }, { unique: true });

export default projectRefundSchema;

