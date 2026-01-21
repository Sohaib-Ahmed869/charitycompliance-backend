/**
 * Role Service
 * 
 * Business logic for role management
 */

import { RoleRepository } from '../repositories/roleRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError } from '../utils/logger.js';

export class RoleService {
  constructor(tenantDb) {
    this.roleRepo = new RoleRepository(tenantDb);
  }

  async getAllRoles() {
    try {
      return await this.roleRepo.findAll();
    } catch (error) {
      logError('Failed to get roles', error);
      throw new AppError('Failed to get roles', 500, 'ROLES_FETCH_ERROR');
    }
  }

  async getRoleById(roleId) {
    try {
      const role = await this.roleRepo.findById(roleId);
      if (!role) {
        throw new AppError('Role not found', 404, 'ROLE_NOT_FOUND');
      }
      return role;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to get role', error);
      throw new AppError('Failed to get role', 500, 'ROLE_FETCH_ERROR');
    }
  }

  async createRole(roleData) {
    try {
      const existingRole = await this.roleRepo.findByName(roleData.name);
      if (existingRole) {
        throw new AppError('Role already exists', 409, 'ROLE_EXISTS');
      }

      const role = await this.roleRepo.create({
        ...roleData,
        is_system: false
      });

      return role;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to create role', error);
      throw new AppError('Failed to create role', 500, 'ROLE_CREATE_ERROR');
    }
  }

  async updateRole(roleId, updateData) {
    try {
      const role = await this.roleRepo.findById(roleId);
      if (!role) {
        throw new AppError('Role not found', 404, 'ROLE_NOT_FOUND');
      }

      if (role.is_system && updateData.permissions) {
        throw new AppError('Cannot modify permissions of system role', 403, 'SYSTEM_ROLE_PROTECTED');
      }

      const updatedRole = await this.roleRepo.update(roleId, updateData);
      return updatedRole;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to update role', error);
      throw new AppError('Failed to update role', 500, 'ROLE_UPDATE_ERROR');
    }
  }

  async deleteRole(roleId) {
    try {
      const role = await this.roleRepo.findById(roleId);
      if (!role) {
        throw new AppError('Role not found', 404, 'ROLE_NOT_FOUND');
      }

      await this.roleRepo.delete(roleId);
      return { success: true };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error.message.includes('system role')) {
        throw new AppError('Cannot delete system role', 403, 'SYSTEM_ROLE_PROTECTED');
      }
      logError('Failed to delete role', error);
      throw new AppError('Failed to delete role', 500, 'ROLE_DELETE_ERROR');
    }
  }

  async assignRoleToUser(userId, roleId, departmentId = null, effectiveFrom = null, effectiveTo = null) {
    try {
      const role = await this.roleRepo.findById(roleId);
      if (!role) {
        throw new AppError('Role not found', 404, 'ROLE_NOT_FOUND');
      }

      const userRole = await this.roleRepo.assignRoleToUser(
        userId,
        roleId,
        departmentId,
        effectiveFrom,
        effectiveTo
      );

      return userRole;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to assign role to user', error);
      throw new AppError('Failed to assign role to user', 500, 'ROLE_ASSIGN_ERROR');
    }
  }

  async removeRoleFromUser(userId, roleId) {
    try {
      await this.roleRepo.removeRoleFromUser(userId, roleId);
      return { success: true };
    } catch (error) {
      logError('Failed to remove role from user', error);
      throw new AppError('Failed to remove role from user', 500, 'ROLE_REMOVE_ERROR');
    }
  }

  async getUserRoles(userId) {
    try {
      return await this.roleRepo.getUserRoles(userId);
    } catch (error) {
      logError('Failed to get user roles', error);
      throw new AppError('Failed to get user roles', 500, 'USER_ROLES_FETCH_ERROR');
    }
  }
}
