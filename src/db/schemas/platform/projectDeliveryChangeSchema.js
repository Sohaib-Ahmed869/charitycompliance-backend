import mongoose from 'mongoose';

// Stores partner-submitted receipts/explanations for over-budget delivery changes,
// plus the extra entries applied after internal approval.
const projectDeliveryChangeSchema = new mongoose.Schema(
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
    over_budget_amount: {
      type: Number,
      default: 0,
      min: 0
    },
    admin_details: {
      type: String,
      default: ''
    },
    status: {
      type: String,
      enum: [
        'awaiting_partner_explanation',
        'partner_explanation_submitted',
        'internal_approved',
        'completed'
      ],
      default: 'awaiting_partner_explanation',
      index: true
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
    // Entries we display in “Project Delivery” after approval.
    applied_extra_entries: [
      {
        amount: { type: Number, default: 0 },
        admin_details: { type: String, default: '' },
        partner_notes: { type: String, default: '' },
        receipts: [
          {
            file_name: { type: String, default: '' },
            data_url: { type: String, default: '' }
          }
        ]
      }
    ]
  },
  {
    timestamps: true,
    collection: 'project_delivery_changes'
  }
);

projectDeliveryChangeSchema.index({ org_key: 1, token: 1 }, { unique: true });

export default projectDeliveryChangeSchema;

