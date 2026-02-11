/**
 * Risk Controller
 *
 * HTTP handlers for risk management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { RiskService } from '../services/riskService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { uploadToS3, getFileStream } from '../services/s3Service.js';
import { AppError } from '../middleware/errorHandler.js';

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

/** Add a treatment to a risk (status defaults to 'resolved') */
export const addTreatment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId } = req.params;
  const { control_action, owner, due_date } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(riskId);
  if (!risk) {
    return res.status(404).json({ success: false, error: { message: 'Risk not found' } });
  }

  const updated = await riskRepo.addTreatment(riskId, {
    control_action: control_action || '',
    owner: owner || '',
    due_date: due_date || undefined,
    status: 'resolved'
  });

  // When a treatment is added, move risk from "under_treatment" to "resolved" (treatment in place)
  if (updated?.status === 'under_treatment') {
    await riskRepo.updateStatus(riskId, 'resolved');
    const refreshed = await riskRepo.findById(riskId);
    return res.status(201).json({ success: true, data: refreshed });
  }

  res.status(201).json({ success: true, data: updated });
});

/** Upload evidence for a treatment */
export const addTreatmentEvidence = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId, treatmentIndex } = req.params;
  if (!req.file) {
    return res.status(400).json({ success: false, error: { message: 'Evidence file is required' } });
  }

  const idx = parseInt(treatmentIndex, 10);
  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ success: false, error: { message: 'Invalid treatment index' } });
  }

  const tenantDb = await getTenantConnection(orgId);
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(riskId);
  if (!risk || !risk.treatments?.[idx]) {
    return res.status(404).json({ success: false, error: { message: 'Risk or treatment not found' } });
  }

  const { key } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'risk_evidence'
  );

  const updated = await riskRepo.addEvidenceToTreatment(riskId, idx, {
    file_path: key,
    file_name: req.file.originalname,
    file_size: req.file.size,
    mime_type: req.file.mimetype
  });

  res.status(201).json({ success: true, data: updated });
});

/** Stream evidence file for viewing */
export const streamEvidence = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId, treatmentIndex, evidenceIndex } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(riskId);
  if (!risk || !risk.treatments?.[treatmentIndex]) {
    throw new AppError('Risk or treatment not found', 404, 'NOT_FOUND');
  }
  const evidence = risk.treatments[treatmentIndex].evidence?.[evidenceIndex];
  if (!evidence?.file_path) {
    throw new AppError('Evidence not found', 404, 'NOT_FOUND');
  }
  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await getFileStream(evidence.file_path, rangeHeader);
  res.setHeader('Content-Type', ContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(evidence.file_name || 'evidence')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});
