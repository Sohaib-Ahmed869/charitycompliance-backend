import mongoose from 'mongoose';

const donorRefundSchema = new mongoose.Schema(
  {
    org_key: {
      type: String,
      required: true,
      index: true
    },
    org_id: {
      type: String,
      required: true,
      index: true
    },
    donor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Donor',
      required: true,
      index: true
    },
    token: {
      type: String,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: [
        'pending_initiation',
        'awaiting_donor_form',
        'donor_form_submitted',
        'internal_approved',
        'internal_rejected',
        'refund_processing',
        'refund_payment_sent',
        'awaiting_donor_acknowledgment',
        'donor_acknowledged',
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
    donor_contact_email: {
      type: String,
      trim: true
    },
    admin_notes: {
      type: String,
      default: ''
    },
    donor_submission: {
      submitted_at: {
        type: Date
      },
      donation_date: {
        type: String,
        default: ''
      },
      donation_amount: {
        type: Number,
        default: 0,
        min: 0
      },
      payment_method: {
        type: String,
        default: ''
      },
      reason: {
        type: String,
        default: ''
      },
      notes: {
        type: String,
        default: '',
        trim: true
      },
      evidence: [
        {
          file_name: { type: String, default: '' },
          data_url: { type: String, default: '' },
          url: { type: String, default: '' },
          key: { type: String, default: '' }
        }
      ]
    },
    internal_approval_request_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApprovalRequest'
    },
    internal_approved_at: {
      type: Date
    },
    processing_started_at: {
      type: Date
    },
    processing_notes: {
      type: String,
      default: '',
      trim: true
    },
    expected_payment_date: {
      type: String,
      default: '',
      trim: true
    },
    refund_payment_sent_at: {
      type: Date
    },
    payment_reference: {
      type: String,
      default: '',
      trim: true
    },
    payment_proof: [
      {
        file_name: { type: String, default: '' },
        data_url: { type: String, default: '' },
        url: { type: String, default: '' },
        key: { type: String, default: '' }
      }
    ],
    payment_notification: {
      message_for_donor: {
        type: String,
        default: ''
      },
      amount_paid: {
        type: Number,
        default: 0,
        min: 0
      },
      payment_method_used: {
        type: String,
        default: '',
        trim: true
      },
      sent_at: {
        type: Date
      }
    },
    payment_ack_token: {
      type: String,
      trim: true,
      index: true
    },
    donor_payment_acknowledgment: {
      submitted_at: {
        type: Date
      },
      signer_name: {
        type: String,
        default: '',
        trim: true
      },
      confirm_received: {
        type: Boolean,
        default: false
      },
      notes: {
        type: String,
        default: '',
        trim: true
      }
    },
    completion_notes: {
      type: String,
      default: '',
      trim: true
    },
    completed_at: {
      type: Date
    }
  },
  {
    timestamps: true,
    // Reuse existing collection to avoid Mongo plan collection-limit failures.
    collection: 'project_refunds'
  }
);

donorRefundSchema.index({ org_key: 1, token: 1 }, { unique: true });
donorRefundSchema.index({ org_key: 1, payment_ack_token: 1 }, { unique: true, sparse: true });

export default donorRefundSchema;
