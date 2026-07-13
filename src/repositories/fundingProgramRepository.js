/**
 * Funding program repository (tenant-scoped)
 */

import fundingProgramSchema from '../db/schemas/platform/fundingProgramSchema.js';
import donorSchema from '../db/schemas/platform/donorSchema.js';
import { escapeRegex } from '../utils/escapeRegex.js';

const DONOR_SUMMARY = 'name donor_type status vip';

export class FundingProgramRepository {
  constructor(tenantDb) {
    // Register Donor model on this tenant connection so populate('donor_id') works.
    tenantDb.models.Donor || tenantDb.model('Donor', donorSchema);
    this.FundingProgram =
      tenantDb.models.FundingProgram || tenantDb.model('FundingProgram', fundingProgramSchema);
  }

  async create(data) {
    const doc = new this.FundingProgram(data);
    return doc.save();
  }

  async findById(id) {
    return this.FundingProgram.findById(id).populate('donor_id', DONOR_SUMMARY);
  }

  async findAllByOrg(orgId, filters = {}) {
    const query = { org_id: orgId };
    if (filters.status) query.status = filters.status;
    if (filters.search) {
      const rx = escapeRegex(filters.search);
      query.$or = [
        { name: { $regex: rx, $options: 'i' } },
        { description: { $regex: rx, $options: 'i' } },
        { beneficiaries: { $regex: rx, $options: 'i' } }
      ];
    }
    return this.FundingProgram.find(query)
      .populate('donor_id', DONOR_SUMMARY)
      .sort({ updatedAt: -1 });
  }

  async update(id, updateData) {
    return this.FundingProgram.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('donor_id', DONOR_SUMMARY);
  }

  async deleteById(id) {
    return this.FundingProgram.findByIdAndDelete(id);
  }
}
