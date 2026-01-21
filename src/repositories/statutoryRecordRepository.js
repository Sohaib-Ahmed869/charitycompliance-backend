/**
 * Statutory Record Repository
 * 
 * Manages registrations, licenses, and statutory obligations
 */

import mongoose from 'mongoose';
import statutoryRecordSchema from '../db/schemas/platform/statutoryRecordSchema.js';

export class StatutoryRecordRepository {
  constructor(tenantDb) {
    this.StatutoryRecord = tenantDb.models.StatutoryRecord || 
      tenantDb.model('StatutoryRecord', statutoryRecordSchema);
  }

  async findByOrgId(orgId, recordType = null) {
    const query = { org_id: orgId };
    if (recordType) {
      query.record_type = recordType;
    }
    return await this.StatutoryRecord.find(query).sort({ issue_date: -1 });
  }

  async findById(id) {
    return await this.StatutoryRecord.findById(id);
  }

  async create(data) {
    const record = new this.StatutoryRecord(data);
    return await record.save();
  }

  async update(id, data) {
    return await this.StatutoryRecord.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true }
    );
  }

  async delete(id) {
    return await this.StatutoryRecord.findByIdAndDelete(id);
  }

  async findExpiringSoon(orgId, daysAhead = 30) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    
    return await this.StatutoryRecord.find({
      org_id: orgId,
      status: 'active',
      expiry_date: { $lte: futureDate, $gte: new Date() }
    }).sort({ expiry_date: 1 });
  }
}
