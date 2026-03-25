/**
 * Donation Box Controller
 * - Create donation boxes (with chosen map location)
 * - Add donation collection entries (tips_count + amount) against a box
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { DonationBoxService } from '../services/donationBoxService.js';
import mongoose from 'mongoose';

const isMongoId = (v) => mongoose.Types.ObjectId.isValid(String(v));

export const listDonationBoxes = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);

  const { status = 'active', search = '' } = req.query;
  const boxes = await service.listBoxes({ status, search });

  res.json({ success: true, data: boxes });
});

export const createDonationBox = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);

  const userId = req.user?.userId || req.userId;
  const box = await service.createBox(req.body, userId);

  res.status(201).json({ success: true, data: box });
});

export const getDonationBoxById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;

  if (!isMongoId(boxId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box ID' },
    });
  }

  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);

  const box = await service.getBox({ boxId });
  res.json({ success: true, data: box });
});

export const addDonationBoxEntry = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;

  if (!isMongoId(boxId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box ID' },
    });
  }

  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);

  const userId = req.user?.userId || req.userId;
  const box = await service.addEntry({ boxId, payload: req.body, userId });

  res.status(201).json({ success: true, data: box });
});

// NOTE: We keep requirePermission imports here for future expansion, but
// routes should apply requirePermission middleware directly.

