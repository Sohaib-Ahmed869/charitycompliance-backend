/**
 * Financial Controls Controller
 *
 * Handles HTTP requests for financial controls
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { FinancialControlsRepository } from '../repositories/financialControlsRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';

export const getFinancialControls = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const financialControlsRepo = new FinancialControlsRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const financialControls = await financialControlsRepo.findByOrgId(org._id);

  res.json({
    success: true,
    data: financialControls
  });
});

export const updateFinancialControls = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const financialControlsRepo = new FinancialControlsRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const updateData = {
    org_id: org._id,
    estimated_annual_revenue: req.body.estimated_annual_revenue,
    financial_year_end_date: req.body.financial_year_end_date ? new Date(req.body.financial_year_end_date) : undefined,
    current_revenue_sources: req.body.current_revenue_sources,
    intended_revenue_sources: req.body.intended_revenue_sources,
    uses_different_reporting_period: req.body.uses_different_reporting_period,
    reporting_period_start_date: req.body.reporting_period_start_date ? new Date(req.body.reporting_period_start_date) : null,
    reporting_period_end_date: req.body.reporting_period_end_date ? new Date(req.body.reporting_period_end_date) : null,
    reason_for_different_period: req.body.reason_for_different_period || null,
    education_id: req.body.education_id || null
  };

  if (req.body.uses_different_reporting_period !== 'yes') {
    updateData.reporting_period_start_date = null;
    updateData.reporting_period_end_date = null;
  }

  if (req.body.uses_different_reporting_period === 'yes') {
    const start = updateData.reporting_period_start_date;
    const end = updateData.reporting_period_end_date;
    if (!start || !end) {
      throw new AppError(
        'Reporting period start and end dates are required when using a different reporting period',
        400,
        'VALIDATION_ERROR'
      );
    }
    if (start > end) {
      throw new AppError(
        'Reporting period end date must be on or after the start date',
        400,
        'VALIDATION_ERROR'
      );
    }
  }

  // Remove undefined fields
  Object.keys(updateData).forEach(key => 
    updateData[key] === undefined && delete updateData[key]
  );

  const financialControls = await financialControlsRepo.update(org._id, updateData);

  logInfo('Financial controls updated', { orgId });

  res.json({
    success: true,
    data: financialControls
  });
});
