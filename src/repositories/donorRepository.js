/**
 * Donor Repository
 *
 * Tenant-scoped donor CRUD operations.
 */

import donorSchema from '../db/schemas/platform/donorSchema.js';

export class DonorRepository {
  constructor(tenantDb) {
    this.Donor = tenantDb.models.Donor || tenantDb.model('Donor', donorSchema);
  }

  async create(data) {
    const donor = new this.Donor(data);
    return donor.save();
  }

  async findById(id) {
    return this.Donor.findById(id);
  }

  async findAllByOrg(orgId, filters = {}) {
    const query = { org_id: orgId };
    if (filters.status) query.status = filters.status;
    if (filters.search) {
      query.name = { $regex: filters.search, $options: 'i' };
    }
    return this.Donor.find(query).sort({ createdAt: -1 });
  }

  async update(id, updateData) {
    return this.Donor.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async deleteById(id) {
    return this.Donor.findByIdAndDelete(id);
  }
}

