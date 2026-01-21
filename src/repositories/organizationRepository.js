/**
 * Organization Repository
 * 
 * Database operations for organization in tenant databases
 */

import mongoose from 'mongoose';
import organizationSchema from '../db/schemas/platform/organizationSchema.js';

export class OrganizationRepository {
  constructor(tenantDb) {
    // Reuse compiled model per tenant connection to avoid OverwriteModelError
    this.Organization = tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
  }

  async findOne() {
    return await this.Organization.findOne({});
  }

  async create(orgData) {
    const org = new this.Organization(orgData);
    return org.save();
  }

  async update(updateData) {
    return this.Organization.findOneAndUpdate(
      {},
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );
  }

  async updateSettings(settings) {
    return this.Organization.findOneAndUpdate(
      {},
      { $set: { settings } },
      { new: true }
    );
  }
}
