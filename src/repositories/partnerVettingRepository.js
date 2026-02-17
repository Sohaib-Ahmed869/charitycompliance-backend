/**
 * Partner Vetting Repository
 *
 * Manages partner vetting data operations
 */

import partnerVettingSchema from '../db/schemas/platform/partnerVettingSchema.js';

export class PartnerVettingRepository {
  constructor(tenantDb) {
    this.PartnerVetting = tenantDb.models.PartnerVetting || tenantDb.model('PartnerVetting', partnerVettingSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.search) {
      const pattern = new RegExp(filters.search, 'i');
      query.$or = [
        { organization_name: pattern },
        { trading_name: pattern },
        { abn_registration_number: pattern }
      ];
    }

    return await this.PartnerVetting.find(query)
      .sort({ createdAt: -1 });
  }

  async findById(id) {
    return await this.PartnerVetting.findById(id);
  }

  async create(data) {
    const partner = new this.PartnerVetting(data);
    return await partner.save();
  }

  async update(id, updateData) {
    return await this.PartnerVetting.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.PartnerVetting.findByIdAndDelete(id);
  }

  async updateDocument(partnerId, docIndex, updateData) {
    const keyBase = `documents.${docIndex}`;
    const setData = {};
    Object.keys(updateData || {}).forEach((field) => {
      setData[`${keyBase}.${field}`] = updateData[field];
    });
    setData.updatedAt = new Date();
    return await this.PartnerVetting.findByIdAndUpdate(
      partnerId,
      { $set: setData },
      { new: true, runValidators: true }
    );
  }

  async getCountsByOrg(orgId) {
    const partners = await this.PartnerVetting.find({ org_id: orgId });
    const today = new Date();
    const expiringSoon = new Date();
    expiringSoon.setDate(today.getDate() + 30);

    const active = partners.filter((p) => p.status === 'approved').length;
    const pending = partners.filter((p) => p.status === 'pending').length;
    const expired = partners.filter((p) => p.review_date && p.review_date < today).length;
    const expiring = partners.filter((p) => p.review_date && p.review_date >= today && p.review_date <= expiringSoon).length;

    return {
      total: partners.length,
      active,
      pending,
      expired,
      expiring
    };
  }
}
