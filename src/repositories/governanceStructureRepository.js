/**
 * Governance Structure Repository
 * 
 * Manages governance structure and compliance data
 */

import mongoose from 'mongoose';
import governanceStructureSchema from '../db/schemas/platform/governanceStructureSchema.js';

export class GovernanceStructureRepository {
  constructor(tenantDb) {
    this.GovernanceStructure = tenantDb.models.GovernanceStructure || 
      tenantDb.model('GovernanceStructure', governanceStructureSchema);
  }

  async findByOrgId(orgId) {
    return await this.GovernanceStructure.findOne({ org_id: orgId });
  }

  async create(data) {
    const governanceStructure = new this.GovernanceStructure(data);
    return await governanceStructure.save();
  }

  async update(orgId, data) {
    return await this.GovernanceStructure.findOneAndUpdate(
      { org_id: orgId },
      { $set: data },
      { new: true, upsert: true }
    );
  }

  async delete(orgId) {
    return await this.GovernanceStructure.findOneAndDelete({ org_id: orgId });
  }
}
