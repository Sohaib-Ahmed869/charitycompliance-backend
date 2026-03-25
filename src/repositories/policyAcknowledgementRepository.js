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

  async findOneByPolicyAndBoardMember(policyId, boardMemberId) {
    return this.PolicyAcknowledgement.findOne({
      policy_id: policyId,
      board_member_id: boardMemberId
    }).lean();
  }

  async acknowledge(policyId, userId, signatureData = null, userName = null, userTitle = null) {
    const existing = await this.PolicyAcknowledgement.findOne({ policy_id: policyId, user_id: userId });
    if (existing) {
      return existing;
    }
    const record = new this.PolicyAcknowledgement({
      policy_id: policyId,
      user_id: userId,
      signature_data: signatureData,
      user_name: userName,
      user_title: userTitle
    });
    return record.save();
  }

  async acknowledgeByBoardMember(policyId, boardMemberId, signatureData = null, userName = null, userTitle = null) {
    const existing = await this.PolicyAcknowledgement.findOne({
      policy_id: policyId,
      board_member_id: boardMemberId
    });
    if (existing) {
      return existing;
    }
    const record = new this.PolicyAcknowledgement({
      policy_id: policyId,
      board_member_id: boardMemberId,
      signature_data: signatureData,
      user_name: userName,
      user_title: userTitle
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
      .sort({ acknowledged_at: -1 })
      .lean();
  }

  async findByUserId(userId) {
    return this.PolicyAcknowledgement.find({ user_id: userId }).lean();
  }

  async deleteByUserId(userId) {
    return this.PolicyAcknowledgement.deleteMany({ user_id: userId });
  }
}
