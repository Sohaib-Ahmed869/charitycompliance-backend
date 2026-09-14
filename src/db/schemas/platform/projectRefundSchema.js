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
    // project_id is required ONLY for variance-initiated refunds (sourced
    // from a real Project Delivery record). Manual entries set
    // source: 'manual' and use manual_project_name / manual_funder_name
    // free-text fields instead.
    project_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectRegister',
      required: function () { return this.source !== 'manual'; },
      index: true
    },
    agreement_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FundingAgreement'
    },
    // 'variance' = current path (project delivery surfaces a residual,
    // a workflow + partner receipts run).
    // 'manual'   = bookkeeping entry; no workflow, no partner form.
    source: {
      type: String,
      enum: ['variance', 'manual'],
      default: 'variance',
      index: true
    },
    // Manual-entry identifying fields. Populated only when source === 'manual'.
    manual_project_name: { type: String, trim: true, default: '' },
    manual_funder_name:  { type: String, trim: true, default: '' },
    manual_refund_date:  { type: String, trim: true, default: '' }, // YYYY-MM-DD
    manual_payment_method: { type: String, trim: true, default: '' },
    manual_reason:       { type: String, trim: true, default: '' },
    manual_attachments: [{
      file_name: { type: String, default: '' },
      url:       { type: String, default: '' },
      key:       { type: String, default: '' }
    }],
    // token only required for the variance-initiated partner-receipts flow.
    token: {
      type: String,
      required: function () { return this.source !== 'manual'; },
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
        // Manual project refunds skip the partner-receipts step and land
        // here on save. The refunds approval workflow runs on top, then
        // the engine flips this to `completed`.
        'awaiting_internal_approval',
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
    },
    completed_at: {
      type: Date
    },
    completed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    completed_note: {
      type: String,
      default: ''
    },
    completed_signature_data: {
      type: String,
      default: ''
    }
  },
  {
    timestamps: true,
    collection: 'project_refunds'
  }
);

// Token is only set on variance-initiated refunds. Manual entries have
// no token; a plain unique compound index would treat null tokens as
// colliding. Partial filter so uniqueness only applies to real strings.
projectRefundSchema.index(
  { org_key: 1, token: 1 },
  { unique: true, partialFilterExpression: { token: { $type: 'string' } } }
);

export default projectRefundSchema;

