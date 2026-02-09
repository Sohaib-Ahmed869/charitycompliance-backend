/**
 * Policy Acknowledgement Repository
 */

import policyAcknowledgementSchema from '../db/schemas/platform/policyAcknowledgementSchema.js';

export class PolicyAcknowledgementRepository {
  constructor(tenantDb) {
    this.PolicyAcknowledgement =
      tenantDb.models.PolicyAcknowledgement ||
      tenantDb.model('PolicyAcknowledgement', policyAcknowledgementSchema);
  }

  async findOneByPolicyAndUser(policyId, userId) {
    return this.PolicyAcknowledgement.findOne({
      policy_id: policyId,
      user_id: userId
    }).lean();
  }

  async acknowledge(policyId, userId, signatureData = null) {
    const existing = await this.PolicyAcknowledgement.findOne({ policy_id: policyId, user_id: userId });
    if (existing) {
      return existing;
    }
    const record = new this.PolicyAcknowledgement({
      policy_id: policyId,
      user_id: userId,
      signature_data: signatureData
    });
    return record.save();
  }

  async hasAcknowledged(policyId, userId) {
    const record = await this.PolicyAcknowledgement.findOne({ policy_id: policyId, user_id: userId }).lean();
    return !!record;
  }

  async countByPolicyId(policyId) {
    return this.PolicyAcknowledgement.countDocuments({ policy_id: policyId });
  }

  async findByPolicyId(policyId) {
    return this.PolicyAcknowledgement.find({ policy_id: policyId })
      .populate('user_id', 'first_name last_name email given_names family_name')
      .sort({ acknowledged_at: -1 })
      .lean();
  }
}
