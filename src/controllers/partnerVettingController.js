/**
 * Partner Vetting Controller
 *
 * HTTP handlers for partner vetting management
 */

import { validationResult } from 'express-validator';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PartnerVettingService } from '../services/partnerVettingService.js';

export const createPartner = asyncHandler(async (req, res) => {
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
  const service = new PartnerVettingService(orgId);
  const partner = await service.createPartner({
    ...req.body,
    submitted_by: userId
  });

  res.status(201).json({
    success: true,
    data: partner
  });
});

export const getPartners = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    search: req.query.search
  };

  const service = new PartnerVettingService(orgId);
  const partners = await service.getPartners(filters);

  res.json({
    success: true,
    data: partners
  });
});

export const getPartnerCounts = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new PartnerVettingService(orgId);
  const counts = await service.getPartnerCounts();

  res.json({
    success: true,
    data: counts
  });
});

export const getPartnerById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId } = req.params;

  const service = new PartnerVettingService(orgId);
  const partner = await service.getPartnerById(partnerId);

  res.json({
    success: true,
    data: partner
  });
});

export const updatePartner = asyncHandler(async (req, res) => {
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
  const { partnerId } = req.params;
  const service = new PartnerVettingService(orgId);
  const partner = await service.updatePartner(partnerId, req.body);

  res.json({
    success: true,
    data: partner
  });
});

export const deletePartner = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId } = req.params;
  const service = new PartnerVettingService(orgId);
  await service.deletePartner(partnerId);

  res.json({
    success: true,
    data: { deleted: true }
  });
});

export const uploadPartnerDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId, docIndex } = req.params;
  if (!req.file) {
    return res.status(400).json({ success: false, error: { message: 'Document file is required' } });
  }

  const index = parseInt(docIndex, 10);
  if (Number.isNaN(index) || index < 0) {
    return res.status(400).json({ success: false, error: { message: 'Invalid document index' } });
  }

  const service = new PartnerVettingService(orgId);
  const partner = await service.uploadDocument(partnerId, index, req.file);

  res.status(201).json({
    success: true,
    data: partner
  });
});

export const streamPartnerDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId, docIndex } = req.params;
  const index = parseInt(docIndex, 10);
  if (Number.isNaN(index) || index < 0) {
    return res.status(400).json({ success: false, error: { message: 'Invalid document index' } });
  }

  const service = new PartnerVettingService(orgId);
  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await service.streamDocument(
    partnerId,
    index,
    rangeHeader
  );

  res.setHeader('Content-Type', ContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});
