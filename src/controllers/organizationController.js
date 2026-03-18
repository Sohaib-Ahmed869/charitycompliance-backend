/**
 * Organization Controller
 * 
 * Handles HTTP requests for organization endpoints
 */

import { OrganizationService } from '../services/organizationService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const getOrganization = asyncHandler(async (req, res) => {
  const orgService = new OrganizationService(req.tenantDb);
  const org = await orgService.getOrganization();

  res.json({
    success: true,
    data: org
  });
});

export const updateOrganization = asyncHandler(async (req, res) => {
  const orgService = new OrganizationService(req.tenantDb);
  // Debug log to inspect incoming body
  // eslint-disable-next-line no-console
  console.log('updateOrganization payload (backend):', {
    ...req.body,
    logo_url: req.body?.logo_url ? `data-url-len:${String(req.body.logo_url).length}` : null
  });

  const org = await orgService.updateOrganization(req.body);

  res.json({
    success: true,
    data: org
  });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const orgService = new OrganizationService(req.tenantDb);
  const org = await orgService.updateSettings(req.body);

  res.json({
    success: true,
    data: org
  });
});
