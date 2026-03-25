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
    /** Staff with login — one of user_id or board_member_id must be set */
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true
    },
    /** Volunteers without system access — acknowledgement tied to responsible-person record */
    board_member_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BoardMember',
      required: false,
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

policyAcknowledgementSchema.pre('validate', function validateAckSubject(next) {
  if (!this.user_id && !this.board_member_id) {
    this.invalidate('user_id', 'Either user_id or board_member_id is required');
  }
  next();
});

policyAcknowledgementSchema.index(
  { policy_id: 1, user_id: 1 },
  { unique: true, partialFilterExpression: { user_id: { $exists: true, $ne: null } } }
);
policyAcknowledgementSchema.index(
  { policy_id: 1, board_member_id: 1 },
  { unique: true, partialFilterExpression: { board_member_id: { $exists: true, $ne: null } } }
);

export default policyAcknowledgementSchema;
