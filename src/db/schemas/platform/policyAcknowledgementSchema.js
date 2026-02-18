/**
 * Policy Acknowledgement Schema (Tenant DB)
 * Records when a user acknowledges an approved policy
 */

import mongoose from 'mongoose';

const policyAcknowledgementSchema = new mongoose.Schema(
  {
    policy_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Policy',
      required: true,
      index: true
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    user_name: {
      type: String
    },
    user_title: {
      type: String
    },
    acknowledged_at: {
      type: Date,
      default: Date.now
    },
    signature_data: {
      type: String
    }
  },
  {
    timestamps: true,
    collection: 'policy_acknowledgements'
  }
);

policyAcknowledgementSchema.index({ policy_id: 1, user_id: 1 }, { unique: true });

export default policyAcknowledgementSchema;
