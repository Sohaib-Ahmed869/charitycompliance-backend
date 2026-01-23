/**
 * User Position Repository
 * 
 * Manages user-position assignments
 */

import mongoose from 'mongoose';
import userPositionSchema from '../db/schemas/platform/userPositionSchema.js';

export class UserPositionRepository {
  constructor(tenantDb) {
    this.UserPosition = tenantDb.models.UserPosition || 
      tenantDb.model('UserPosition', userPositionSchema);
  }

  async findByUserId(userId, activeOnly = true) {
    const query = { user_id: userId };
    if (activeOnly) {
      query.is_active = true;
      query.$or = [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ];
    }
    return await this.UserPosition.find(query)
      .populate('position_id')
      .populate('department_id')
      .sort({ effective_from: -1 });
  }

  async findByPositionId(positionId, activeOnly = true) {
    const query = { position_id: positionId };
    if (activeOnly) {
      query.is_active = true;
      query.$or = [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ];
    }
    return await this.UserPosition.find(query)
      .populate('user_id')
      .populate('department_id')
      .sort({ effective_from: -1 });
  }

  async findByDepartmentId(departmentId, activeOnly = true) {
    const query = { department_id: departmentId };
    if (activeOnly) {
      query.is_active = true;
      query.$or = [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ];
    }
    return await this.UserPosition.find(query)
      .populate('user_id')
      .populate('position_id')
      .sort({ effective_from: -1 });
  }

  async findByOrgId(orgId, activeOnly = true) {
    const query = { org_id: orgId };
    if (activeOnly) {
      query.is_active = true;
      query.$or = [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ];
    }
    return await this.UserPosition.find(query)
      .populate('user_id')
      .populate('position_id')
      .populate('department_id')
      .sort({ effective_from: -1 });
  }

  async findUsersByPositionId(positionId, activeOnly = true) {
    const query = { position_id: positionId };
    if (activeOnly) {
      query.is_active = true;
      query.$or = [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ];
    }
    const userPositions = await this.UserPosition.find(query)
      .populate('user_id')
      .select('user_id');
    
    // Extract unique user IDs
    const userIds = [...new Set(userPositions.map(up => up.user_id?._id || up.user_id))];
    return userIds;
  }

  async findUsersByDepartmentId(departmentId, activeOnly = true) {
    const query = { department_id: departmentId };
    if (activeOnly) {
      query.is_active = true;
      query.$or = [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ];
    }
    const userPositions = await this.UserPosition.find(query)
      .populate('user_id')
      .select('user_id');
    
    // Extract unique user IDs
    const userIds = [...new Set(userPositions.map(up => up.user_id?._id || up.user_id))];
    return userIds;
  }

  async create(data) {
    const userPosition = new this.UserPosition(data);
    return await userPosition.save();
  }

  async update(id, updateData) {
    return await this.UserPosition.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async deactivate(id) {
    return await this.UserPosition.findByIdAndUpdate(
      id,
      { 
        $set: { 
          is_active: false,
          effective_to: new Date()
        }
      },
      { new: true }
    );
  }

  async findById(id) {
    return await this.UserPosition.findById(id)
      .populate('user_id')
      .populate('position_id')
      .populate('department_id');
  }

  async findActiveByUserAndPosition(userId, positionId) {
    return await this.UserPosition.findOne({
      user_id: userId,
      position_id: positionId,
      is_active: true,
      $or: [
        { effective_to: null },
        { effective_to: { $gte: new Date() } }
      ]
    });
  }
}
