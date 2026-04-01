/**
 * Funding Agreement Repository
 *
 * Manages funding agreement data operations
 */

import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';

export class FundingAgreementRepository {
  constructor(tenantDb) {
    this.FundingAgreement = tenantDb.models.FundingAgreement || tenantDb.model('FundingAgreement', fundingAgreementSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.search) {
      const pattern = new RegExp(filters.search, 'i');
      query.$or = [
        { agreement_title: pattern },
        { partner_name: pattern },
        { agreement_type: pattern }
      ];
    }

    return await this.FundingAgreement.find(query)
      .sort({ createdAt: -1 });
  }

  async findById(id) {
    return await this.FundingAgreement.findById(id);
  }

  async findByPartnerSignToken(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    return await this.FundingAgreement.findOne({ partner_sign_token: t });
  }

  async create(data) {
    const agreement = new this.FundingAgreement(data);
    return await agreement.save();
  }

  async update(id, updateData) {
    return await this.FundingAgreement.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.FundingAgreement.findByIdAndDelete(id);
  }

  async getCountsByOrg(orgId) {
    const agreements = await this.FundingAgreement.find({ org_id: orgId });
    const total = agreements.length;
    const approved = agreements.filter((a) => a.status === 'approved').length;
    const pending = agreements.filter((a) => a.status === 'pending').length;
    const rejected = agreements.filter((a) => a.status === 'rejected').length;
    const committed = agreements
      .filter((a) => a.status === 'approved')
      .reduce((sum, item) => sum + (Number(item.total_amount) || 0), 0);

    return {
      total,
      approved,
      pending,
      rejected,
      committed
    };
  }
}
