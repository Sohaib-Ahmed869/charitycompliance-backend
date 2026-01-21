/**
 * Role Repository
 * 
 * Database operations for roles in tenant databases
 */

import mongoose from 'mongoose';
import roleSchema from '../db/schemas/platform/roleSchema.js';
import userRoleSchema from '../db/schemas/platform/userRoleSchema.js';

export class RoleRepository {
  constructor(tenantDb) {
    this.Role = tenantDb.model('Role', roleSchema);
    this.UserRole = tenantDb.model('UserRole', userRoleSchema);
  }

  async findAll() {
    return this.Role.find({}).sort({ name: 1 });
  }

  async findById(roleId) {
    return this.Role.findById(roleId);
  }

  async findByName(name) {
    return this.Role.findOne({ name });
  }

  async create(roleData) {
    const role = new this.Role(roleData);
    return role.save();
  }

  async update(roleId, updateData) {
    return this.Role.findByIdAndUpdate(
      roleId,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(roleId) {
    const role = await this.Role.findById(roleId);
    if (role?.is_system) {
      throw new Error('Cannot delete system role');
    }
    return this.Role.findByIdAndDelete(roleId);
  }

  async assignRoleToUser(userId, roleId, departmentId = null, effectiveFrom = null, effectiveTo = null) {
    const userRole = new this.UserRole({
      user_id: userId,
      role_id: roleId,
      department_id: departmentId,
      effective_from: effectiveFrom || new Date(),
      effective_to: effectiveTo,
      is_active: true
    });
    return userRole.save();
  }

  async removeRoleFromUser(userId, roleId) {
    return this.UserRole.updateMany(
      { user_id: userId, role_id: roleId },
      { $set: { is_active: false, effective_to: new Date() } }
    );
  }

  async getUserRoles(userId) {
    return this.UserRole.find({
      user_id: userId,
      is_active: true,
      $or: [
        { effective_to: null },
        { effective_to: { $gt: new Date() } }
      ]
    }).populate('role_id').populate('department_id');
  }

  async getUsersByRole(roleId) {
    return this.UserRole.find({
      role_id: roleId,
      is_active: true,
      $or: [
        { effective_to: null },
        { effective_to: { $gt: new Date() } }
      ]
    }).populate('user_id');
  }
}
