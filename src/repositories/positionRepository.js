/**
 * Position Repository
 * 
 * Manages position data operations
 */

import mongoose from 'mongoose';
import positionSchema from '../db/schemas/platform/positionSchema.js';

const _repairedDbs = new WeakSet();

export class PositionRepository {
  constructor(tenantDb) {
    this.Position = tenantDb.models.Position || 
      tenantDb.model('Position', positionSchema);
    this._tenantDb = tenantDb;

    if (!_repairedDbs.has(tenantDb)) {
      _repairedDbs.add(tenantDb);
      this._repairPromise = this._dropBadCodeIndex().catch(() => {});
    }
  }

  /** Drop the legacy unique index on (org_id, code) — code does not need uniqueness. */
  async _dropBadCodeIndex() {
    try {
      await this._tenantDb.collection('positions').dropIndex('org_id_1_code_1');
    } catch (_) { /* already gone */ }
  }

  async findByOrgId(orgId) {
    return await this.Position.find({ org_id: orgId, is_active: true })
      .sort({ level: 1, title: 1 });
  }

  async findByDepartment(orgId, departmentId) {
    return await this.Position.find({ 
      org_id: orgId, 
      department_id: departmentId,
      is_active: true 
    }).sort({ level: 1, title: 1 });
  }

  async findById(id) {
    return await this.Position.findById(id);
  }

  async create(data) {
    if (this._repairPromise) await this._repairPromise;
    const position = new this.Position(data);
    return await position.save();
  }

  async createMany(positions) {
    if (this._repairPromise) await this._repairPromise;
    return await this.Position.insertMany(positions);
  }

  async update(id, updateData) {
    return await this.Position.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.Position.findByIdAndUpdate(
      id,
      { $set: { is_active: false } },
      { new: true }
    );
  }

  async updateOccupantCount(positionId, increment = true) {
    const change = increment ? 1 : -1;
    return await this.Position.findByIdAndUpdate(
      positionId,
      { $inc: { current_occupant_count: change } },
      { new: true }
    );
  }
}
