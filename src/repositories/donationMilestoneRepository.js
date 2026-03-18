import donationMilestoneSchema from '../db/schemas/platform/donationMilestoneSchema.js';

export class DonationMilestoneRepository {
  constructor(tenantDb) {
    this.DonationMilestone =
      tenantDb.models.DonationMilestone ||
      tenantDb.model('DonationMilestone', donationMilestoneSchema);
  }

  async create(data) {
    const doc = new this.DonationMilestone(data);
    return doc.save();
  }

  async findByOrg(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.funding_agreement_id) {
      query.funding_agreement_id = filters.funding_agreement_id;
    }

    if (filters.search) {
      const regex = new RegExp(filters.search, 'i');
      query.title = regex;
    }

    return this.DonationMilestone.find(query)
      .sort({ due_date: 1 })
      .lean();
  }
}

