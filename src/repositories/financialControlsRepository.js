/**
 * Financial Controls Repository
 * 
 * Manages financial controls and reporting period data
 */

import mongoose from 'mongoose';
import financialControlsSchema from '../db/schemas/platform/financialControlsSchema.js';

export class FinancialControlsRepository {
  constructor(tenantDb) {
    this.FinancialControls = tenantDb.models.FinancialControls || 
      tenantDb.model('FinancialControls', financialControlsSchema);
  }

  async findByOrgId(orgId) {
    return await this.FinancialControls.findOne({ org_id: orgId });
  }

  async create(data) {
    const financialControls = new this.FinancialControls(data);
    return await financialControls.save();
  }

  async update(orgId, data) {
    return await this.FinancialControls.findOneAndUpdate(
      { org_id: orgId },
      { $set: data },
      { new: true, upsert: true }
    );
  }

  async delete(orgId) {
    return await this.FinancialControls.findOneAndDelete({ org_id: orgId });
  }
}
