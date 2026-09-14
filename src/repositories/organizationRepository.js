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
    // Load → assign → save (NOT findOneAndUpdate). Two reasons:
    //   1. Encryption: fields marked { encrypted: true } (email, address, …) are
    //      encrypted only by the pre('save') hook. findOneAndUpdate bypasses it,
    //      so it would write PII as plaintext and skip the blind-index hashes.
    //   2. Required validators: the org always exists post-signup, so saving the
    //      hydrated doc (which already has `name`) avoids the upsert+runValidators
    //      footgun that rejected partial saves with "Path `name` is required".
    // The hydrated doc has encrypted fields decrypted in memory (post-init), so
    // pre('save') re-encrypts everything correctly on the way back out.
    const doc = await this.Organization.findOne({});
    if (!doc) return null;
    for (const [key, value] of Object.entries(updateData)) {
      doc.set(key, value);
    }
    // Mixed paths don't always register deep changes — force them.
    if ('settings' in updateData) doc.markModified('settings');
    if ('metadata' in updateData) doc.markModified('metadata');
    return await doc.save();
  }

  async updateSettings(settings) {
    return this.Organization.findOneAndUpdate(
      {},
      { $set: { settings } },
      { new: true }
    );
  }
}
