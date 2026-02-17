/**
 * Approval Threshold Controller
 * 
 * Manages monetary thresholds for financial approval workflows
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { getTenantConnection } from '../db/connectionManager.js';
import { ApprovalThresholdRepository } from '../repositories/approvalThresholdRepository.js';

// Get current thresholds
export const getThresholds = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const thresholdRepo = new ApprovalThresholdRepository(tenantDb);

  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();

  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  let thresholds = await thresholdRepo.findByOrgId(org._id);

  // If no thresholds exist, create default ones
  if (!thresholds) {
    thresholds = await thresholdRepo.create({
      org_id: org._id,
      currency: 'USD',
      tiers: [
        { name: 'petty_cash', min_amount: 0, max_amount: 100 },
        { name: 'low_cash', min_amount: 101, max_amount: 500 },
        { name: 'moderate_cash', min_amount: 501, max_amount: 2000 },
        { name: 'high_cash', min_amount: 2001, max_amount: null }
      ],
      updated_by: req.user.userId
    });
  }

  res.json({
    success: true,
    data: thresholds
  });
});

// Update thresholds
export const updateThresholds = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { currency, tiers } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const thresholdRepo = new ApprovalThresholdRepository(tenantDb);

  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();

  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  // Validate tier structure
  if (!Array.isArray(tiers) || tiers.length !== 4) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TIERS', message: 'Must provide exactly 4 tiers' }
    });
  }

  // Ensure tiers are in order and don't overlap
  const sortedTiers = [...tiers].sort((a, b) => a.min_amount - b.min_amount);
  for (let i = 0; i < sortedTiers.length - 1; i++) {
    const current = sortedTiers[i];
    const next = sortedTiers[i + 1];

    if (current.max_amount === null) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TIERS', message: 'Only the highest tier can have unlimited max' }
      });
    }

    if (current.max_amount >= next.min_amount) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TIERS', message: 'Tiers cannot overlap' }
      });
    }

    if (current.max_amount + 1 !== next.min_amount) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TIERS', message: 'Tiers must be continuous with no gaps' }
      });
    }
  }

  const thresholds = await thresholdRepo.update(org._id, {
    currency: currency || 'USD',
    tiers: sortedTiers,
    updated_by: userId
  });

  res.json({
    success: true,
    data: thresholds,
    message: 'Thresholds updated successfully'
  });
});

// Get tier for specific amount
export const getTierForAmount = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { amount } = req.query;

  if (!amount || isNaN(amount)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_AMOUNT', message: 'Valid amount is required' }
    });
  }

  const tenantDb = await getTenantConnection(orgId);
  const thresholdRepo = new ApprovalThresholdRepository(tenantDb);

  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();

  if (!org) {
    return res.status(404).json({
      success: false,
      error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' }
    });
  }

  const tier = await thresholdRepo.getTierForAmount(org._id, parseFloat(amount));

  res.json({
    success: true,
    data: {
      amount: parseFloat(amount),
      tier: tier
    }
  });
});
