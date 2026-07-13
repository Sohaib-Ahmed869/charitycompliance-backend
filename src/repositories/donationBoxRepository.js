import donationBoxSchema from '../db/schemas/platform/donationBoxSchema.js';
import { escapeRegex } from '../utils/escapeRegex.js';

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
      const regex = new RegExp(escapeRegex(search), 'i');
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

  async updateEntryProof({ orgId, boxId, entryId, update }) {
    return this.DonationBox.findOneAndUpdate(
      { _id: boxId, org_id: orgId },
      {
        $set: {
          'entries.$[e].proof_status': update.proof_status,
          'entries.$[e].proof_files': update.proof_files,
          'entries.$[e].proof_added_by': update.proof_added_by,
          'entries.$[e].proof_added_at': update.proof_added_at,
          'entries.$[e].proof_assigned_to': update.proof_assigned_to,
          updated_at: new Date(),
        },
      },
      { new: true, arrayFilters: [{ 'e._id': entryId }] }
    ).lean();
  }

  /**
   * @param {Record<string, unknown>} fields - keys are entry subdocument paths (no `entries.` prefix)
   */
  async updateEntryFields({ orgId, boxId, entryId, fields }) {
    const $set = { updated_at: new Date() };
    for (const [key, value] of Object.entries(fields || {})) {
      $set[`entries.$[e].${key}`] = value;
    }
    return this.DonationBox.findOneAndUpdate(
      { _id: boxId, org_id: orgId },
      { $set },
      { new: true, arrayFilters: [{ 'e._id': entryId }] }
    ).lean();
  }

  async updateBoxStatus({ orgId, boxId, status }) {
    return this.DonationBox.findOneAndUpdate(
      { _id: boxId, org_id: orgId },
      { $set: { status, updated_at: new Date() } },
      { new: true }
    ).lean();
  }
}

