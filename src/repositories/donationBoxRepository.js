import donationBoxSchema from '../db/schemas/platform/donationBoxSchema.js';

export class DonationBoxRepository {
  constructor(tenantDb) {
    this.DonationBox =
      tenantDb.models.DonationBox || tenantDb.model('DonationBox', donationBoxSchema);
  }

  async create(data) {
    const doc = new this.DonationBox(data);
    return doc.save();
  }

  async list({ orgId, status = 'active', search = '' } = {}) {
    const query = { org_id: orgId };
    if (status) query.status = status;
    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ name: regex }, { 'location.address': regex }];
    }

    return this.DonationBox.find(query).sort({ updated_at: -1 }).lean();
  }

  async findById({ orgId, boxId }) {
    return this.DonationBox.findOne({ _id: boxId, org_id: orgId }).lean();
  }

  async addEntry({ orgId, boxId, entry }) {
    return this.DonationBox.findOneAndUpdate(
      { _id: boxId, org_id: orgId, status: 'active' },
      {
        $push: { entries: entry },
        $set: { updated_at: new Date() },
      },
      { new: true }
    ).lean();
  }
}

