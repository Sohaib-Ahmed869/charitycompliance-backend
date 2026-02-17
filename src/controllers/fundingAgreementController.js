/**
 * Funding Agreement Controller
 *
 * HTTP handlers for funding agreements
 */

import { validationResult } from 'express-validator';
import { asyncHandler } from '../middleware/errorHandler.js';
import { FundingAgreementService } from '../services/fundingAgreementService.js';

export const createAgreement = asyncHandler(async (req, res) => {
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
  const userId = req.user?.userId || req.userId;
  const service = new FundingAgreementService(orgId);
  const agreement = await service.createAgreement({
    ...req.body,
    submitted_by: userId
  });

  res.status(201).json({
    success: true,
    data: agreement
  });
});

export const getAgreements = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    search: req.query.search
  };

  const service = new FundingAgreementService(orgId);
  const agreements = await service.getAgreements(filters);

  res.json({
    success: true,
    data: agreements
  });
});

export const getAgreementCounts = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new FundingAgreementService(orgId);
  const counts = await service.getAgreementCounts();

  res.json({
    success: true,
    data: counts
  });
});

export const getAgreementById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { agreementId } = req.params;

  const service = new FundingAgreementService(orgId);
  const agreement = await service.getAgreementById(agreementId);

  res.json({
    success: true,
    data: agreement
  });
});
