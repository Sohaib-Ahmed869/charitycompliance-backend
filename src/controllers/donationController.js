/**
 * Donation Controller
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { DonationService } from '../services/donationService.js';
import mongoose from 'mongoose';

export const createDonation = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;

  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationService(orgId, tenantDb);

  const donation = await service.createDonation(req.body, userId);

  res.status(201).json({
    success: true,
    data: donation
  });
});

export const listDonations = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationService(orgId, tenantDb);

  const { status, search } = req.query;
  const donations = await service.listDonations({ status, search });

  res.json({
    success: true,
    data: donations
  });
});

export const getDonationById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const donationId = req.params.donationId;

  if (!mongoose.Types.ObjectId.isValid(donationId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation ID' }
    });
  }

  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationService(orgId, tenantDb);
  const donation = await service.getDonationById(donationId);

  if (!donation) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Donation not found' }
    });
  }

  res.json({
    success: true,
    data: donation
  });
});

