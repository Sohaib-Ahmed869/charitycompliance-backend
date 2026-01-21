/**
 * Position Repository
 * 
 * Manages position data operations
 */

import mongoose from 'mongoose';
import positionSchema from '../db/schemas/platform/positionSchema.js';

export class PositionRepository {
  constructor(tenantDb) {
    this.Position = tenantDb.models.Position || 
      tenantDb.model('Position', positionSchema);
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
    const position = new this.Position(data);
    return await position.save();
  }

  async createMany(positions) {
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
