/**
 * Risk Controller
 *
 * HTTP handlers for risk management
 */

import { RiskService } from '../services/riskService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';

export const createRisk = asyncHandler(async (req, res) => {
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
  // Auth middleware attaches userId (not _id) to req.user
  const userId = req.user?.userId;
  const riskData = req.body;

  const riskService = new RiskService(orgId);
  const risk = await riskService.createRisk(riskData, userId);

  res.status(201).json({
    success: true,
    data: risk
  });
});

export const getRisks = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    category: req.query.category,
    search: req.query.search
  };

  const riskService = new RiskService(orgId);
  const risks = await riskService.getRisks(filters);

  res.json({
    success: true,
    data: risks
  });
});

export const getRiskCounts = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const riskService = new RiskService(orgId);
  const counts = await riskService.getRiskCounts();

  res.json({
    success: true,
    data: counts
  });
});

export const getRiskById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId } = req.params;

  const riskService = new RiskService(orgId);
  const risk = await riskService.getRiskById(riskId);

  res.json({
    success: true,
    data: risk
  });
});

export const updateRisk = asyncHandler(async (req, res) => {
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
  const { riskId } = req.params;
  const updateData = req.body;

  const riskService = new RiskService(orgId);
  const risk = await riskService.updateRisk(riskId, updateData);

  res.json({
    success: true,
    data: risk
  });
});

export const deleteRisk = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId } = req.params;

  const riskService = new RiskService(orgId);
  await riskService.deleteRisk(riskId);

  res.json({
    success: true,
    data: { deleted: true }
  });
});
