import donationSchema from '../db/schemas/platform/donationSchema.js';

export class DonationRepository {
  constructor(tenantDb) {
    this.Donation = tenantDb.models.Donation || tenantDb.model('Donation', donationSchema);
  }

  async create(data) {
    const doc = new this.Donation(data);
    return doc.save();
  }

  async findById(id) {
    return this.Donation.findById(id).lean();
  }

  async findAll(filters = {}) {
    const query = { ...(filters.org_id ? { org_id: filters.org_id } : {}) };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.search) {
      const regex = new RegExp(filters.search, 'i');
      query.$or = [{ title: regex }, { lead_name: regex }];
    }

    return this.Donation.find(query).sort({ createdAt: -1 }).lean();
  }

  async updateStatus(id, status, extra = {}) {
    return this.Donation.findByIdAndUpdate(
      id,
      { status, ...extra },
      { new: true }
    ).lean();
  }
}

