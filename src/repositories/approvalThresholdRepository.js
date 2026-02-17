/**
 * Approval Threshold Repository
 */

import approvalThresholdSchema from '../db/schemas/platform/approvalThresholdSchema.js';

export class ApprovalThresholdRepository {
  constructor(tenantDb) {
    this.model = tenantDb.model('ApprovalThreshold', approvalThresholdSchema);
  }

  async findByOrgId(orgId) {
    return this.model.findOne({ org_id: orgId }).lean();
  }

  async create(data) {
    const threshold = new this.model(data);
    return threshold.save();
  }

  async update(orgId, data) {
    return this.model.findOneAndUpdate(
      { org_id: orgId },
      { ...data, updated_at: new Date() },
      { new: true, upsert: true }
    );
  }

  async delete(orgId) {
    return this.model.deleteOne({ org_id: orgId });
  }

  // Get the appropriate tier for a given amount
  async getTierForAmount(orgId, amount) {
    const thresholds = await this.findByOrgId(orgId);
    if (!thresholds) return null;

    for (const tier of thresholds.tiers) {
      if (amount >= tier.min_amount && (tier.max_amount === null || amount <= tier.max_amount)) {
        return tier.name;
      }
    }
    return null;
  }
}
