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
    // donor_id is required ONLY for system-initiated refunds (sourced
    // from a real Donor record). Manual entries — refunds being recorded
    // for record-keeping for a small donor not in the system — set
    // source: 'manual' and leave donor_id null; manual_donor_name /
    // manual_donor_email below capture the identifying detail instead.
    donor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Donor',
      required: function () { return this.source !== 'manual'; },
      index: true
    },
    // 'donor_initiated' = current path (workflow + donor form + payment ack).
    // 'manual'           = bookkeeping entry; no workflow, no donor form,
    //                      shown in the register with a 'Manual' chip.
    source: {
      type: String,
      enum: ['donor_initiated', 'manual'],
      default: 'donor_initiated',
      index: true
    },
    // Manual-entry identifying fields. Populated only when source === 'manual'.
    manual_donor_name:  { type: String, trim: true, default: '' },
    manual_donor_email: { type: String, trim: true, default: '' },
    manual_receipt_number: { type: String, trim: true, default: '' },
    manual_refund_amount:  { type: Number, default: 0, min: 0 },
    manual_refund_date:    { type: String, default: '', trim: true }, // YYYY-MM-DD
    manual_payment_method: { type: String, trim: true, default: '' },
    manual_reason:         { type: String, trim: true, default: '' },
    manual_attachments: [{
      file_name: { type: String, default: '' },
      url:       { type: String, default: '' },
      key:       { type: String, default: '' }
    }],
    // token is required for the donor-initiated flow (it's the link the
    // donor uses to fill their form). Manual entries don't need one, so
    // also gate by source — matches the donor_id pattern above.
    token: {
      type: String,
      required: function () { return this.source !== 'manual'; },
      index: true
    },
    status: {
      type: String,
      enum: [
        'pending_initiation',
        'awaiting_donor_form',
        'donor_form_submitted',
        // Manual refunds go straight here on save — no public donor form
        // step. The internal approval workflow runs on top, then the
        // engine flips this to `completed`.
        'awaiting_internal_approval',
        'internal_approved',
        'internal_rejected',
        'internal_resubmission_required',
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

// Token is only set on donor-initiated refunds (used as the secret URL
// the donor opens). Manual entries have no token; a plain unique index
// would treat their null tokens as colliding. Make it a partial unique
// index that only enforces uniqueness on real string tokens.
donorRefundSchema.index(
  { org_key: 1, token: 1 },
  { unique: true, partialFilterExpression: { token: { $type: 'string' } } }
);
// payment_ack_token is null until the donor-acknowledgement step begins, and
// org_key is constant within a tenant DB. `sparse` does NOT help a compound
// index here — it only skips docs missing ALL keys, so every { org_key, null }
// row still collides. A PARTIAL index scoped to real string tokens is correct:
// null / missing tokens aren't indexed at all.
donorRefundSchema.index(
  { org_key: 1, payment_ack_token: 1 },
  { unique: true, partialFilterExpression: { payment_ack_token: { $type: 'string' } } }
);

export default donorRefundSchema;
