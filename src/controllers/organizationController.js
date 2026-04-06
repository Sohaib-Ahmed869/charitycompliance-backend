/**
 * Organization Controller
 * 
 * Handles HTTP requests for organization endpoints
 */

import { OrganizationService } from '../services/organizationService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';

export const getOrganization = asyncHandler(async (req, res) => {
  const orgService = new OrganizationService(req.tenantDb);
  const org = await orgService.getOrganization();

  res.json({
    success: true,
    data: org
  });
});

export const updateOrganization = asyncHandler(async (req, res) => {
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const isAdmin = roles.includes('admin') || perms.includes('*:*');
  if (!isAdmin) {
    throw new AppError('Only administrators can edit organisation information', 403, 'FORBIDDEN');
  }
  const orgService = new OrganizationService(req.tenantDb);
  const org = await orgService.updateOrganization(req.body);

  res.json({
    success: true,
    data: org
  });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const isAdmin = roles.includes('admin') || perms.includes('*:*');
  if (!isAdmin) {
    throw new AppError('Only administrators can edit organisation settings', 403, 'FORBIDDEN');
  }
  const orgService = new OrganizationService(req.tenantDb);
  const org = await orgService.updateSettings(req.body);

  res.json({
    success: true,
    data: org
  });
});
