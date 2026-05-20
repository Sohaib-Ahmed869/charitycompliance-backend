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

/**
 * PATCH /platform/donation-boxes/:boxId/status
 *
 * Flip a donation box between active and inactive (CASH-016/017).
 * Lightweight — doesn't touch entries, just sets the status field.
 */
export const setDonationBoxStatus = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;
  const nextStatus = req.body.status;
  if (!isMongoId(boxId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box ID' },
    });
  }
  const tenantDb = await getTenantConnection(orgId);
  // Use the underlying model directly — the service surface doesn't
  // have a status-only update, and adding one there would invite
  // callers to bypass other guarded paths. Status is a simple flag.
  const { default: donationBoxSchema } = await import('../db/schemas/platform/donationBoxSchema.js');
  const DonationBox = tenantDb.models.DonationBox || tenantDb.model('DonationBox', donationBoxSchema);
  const updated = await DonationBox.findByIdAndUpdate(
    boxId,
    { $set: { status: nextStatus, updated_at: new Date() } },
    { new: true }
  );
  if (!updated) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Donation box not found' }
    });
  }
  res.json({ success: true, data: updated });
});

// CASH-010 — update the variance investigation on a single entry.
// Path: PATCH /platform/donation-boxes/:boxId/entries/:entryId/variance-investigation
export const setVarianceInvestigation = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boxId, entryId } = req.params;
  const { status, notes } = req.body || {};

  if (!isMongoId(boxId) || !isMongoId(entryId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box or entry ID' },
    });
  }

  const allowed = ['none', 'open', 'investigating', 'resolved', 'unresolved'];
  const nextStatus = allowed.includes(status) ? status : 'investigating';

  const tenantDb = await getTenantConnection(orgId);
  const { default: donationBoxSchema } = await import('../db/schemas/platform/donationBoxSchema.js');
  const DonationBox = tenantDb.models.DonationBox || tenantDb.model('DonationBox', donationBoxSchema);

  const updated = await DonationBox.findOneAndUpdate(
    { _id: boxId, 'entries._id': entryId },
    {
      $set: {
        'entries.$.variance_investigation.status': nextStatus,
        'entries.$.variance_investigation.notes': String(notes || '').trim(),
        'entries.$.variance_investigation.investigated_by': req.user?.userId || null,
        'entries.$.variance_investigation.investigated_at': new Date(),
        updated_at: new Date(),
      }
    },
    { new: true }
  );

  if (!updated) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Donation box or entry not found' }
    });
  }

  res.json({ success: true, data: updated });
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

export const assignDonationBoxEntryProof = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;
  const entryId = req.params.entryId;
  if (!isMongoId(boxId) || !isMongoId(entryId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box or entry ID' },
    });
  }

  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);
  const userId = req.user?.userId || req.userId;
  const assignedTo = req.body?.assigned_to || req.body?.assignedTo || null;

  const updated = await service.assignEntryProof({ boxId, entryId, assignedToUserId: assignedTo, userId });
  res.json({ success: true, data: updated });
});

export const uploadDonationBoxEntryProof = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;
  const entryId = req.params.entryId;
  if (!isMongoId(boxId) || !isMongoId(entryId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box or entry ID' },
    });
  }

  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);
  const userId = req.user?.userId || req.userId;
  const files = Array.isArray(req.body?.files) ? req.body.files : [];

  const updated = await service.addEntryProof({ boxId, entryId, files, userId });
  res.json({ success: true, data: updated });
});

export const acknowledgeSecondCounter = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;
  const entryId = req.params.entryId;
  if (!isMongoId(boxId) || !isMongoId(entryId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box or entry ID' },
    });
  }
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);
  const userId = req.user?.userId || req.userId;
  const updated = await service.acknowledgeSecondCounter({ boxId, entryId, userId });
  res.json({ success: true, data: updated });
});

export const acknowledgeOfficeReceipt = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const boxId = req.params.boxId;
  const entryId = req.params.entryId;
  if (!isMongoId(boxId) || !isMongoId(entryId)) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid donation box or entry ID' },
    });
  }
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonationBoxService(orgId, tenantDb);
  const userId = req.user?.userId || req.userId;
  const updated = await service.acknowledgeOfficeReceipt({ boxId, entryId, userId });
  res.json({ success: true, data: updated });
});

// NOTE: We keep requirePermission imports here for future expansion, but
// routes should apply requirePermission middleware directly.

