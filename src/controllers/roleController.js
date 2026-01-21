/**
 * Role Controller
 * 
 * Handles HTTP requests for role endpoints
 */

import { RoleService } from '../services/roleService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const getAllRoles = asyncHandler(async (req, res) => {
  const roleService = new RoleService(req.tenantDb);
  const roles = await roleService.getAllRoles();

  res.json({
    success: true,
    data: roles
  });
});

export const getRoleById = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const roleService = new RoleService(req.tenantDb);
  const role = await roleService.getRoleById(roleId);

  res.json({
    success: true,
    data: role
  });
});

export const createRole = asyncHandler(async (req, res) => {
  const roleService = new RoleService(req.tenantDb);
  const role = await roleService.createRole(req.body);

  res.status(201).json({
    success: true,
    data: role
  });
});

export const updateRole = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const roleService = new RoleService(req.tenantDb);
  const role = await roleService.updateRole(roleId, req.body);

  res.json({
    success: true,
    data: role
  });
});

export const deleteRole = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const roleService = new RoleService(req.tenantDb);
  await roleService.deleteRole(roleId);

  res.json({
    success: true,
    message: 'Role deleted successfully'
  });
});

export const assignRoleToUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { roleId, departmentId, effectiveFrom, effectiveTo } = req.body;
  
  const roleService = new RoleService(req.tenantDb);
  const userRole = await roleService.assignRoleToUser(
    userId,
    roleId,
    departmentId,
    effectiveFrom ? new Date(effectiveFrom) : null,
    effectiveTo ? new Date(effectiveTo) : null
  );

  res.status(201).json({
    success: true,
    data: userRole
  });
});

export const removeRoleFromUser = asyncHandler(async (req, res) => {
  const { userId, roleId } = req.params;
  const roleService = new RoleService(req.tenantDb);
  await roleService.removeRoleFromUser(userId, roleId);

  res.json({
    success: true,
    message: 'Role removed from user'
  });
});

export const getUserRoles = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const roleService = new RoleService(req.tenantDb);
  const roles = await roleService.getUserRoles(userId);

  res.json({
    success: true,
    data: roles
  });
});
