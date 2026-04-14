/**
 * Checklist Controller
 *
 * Month/quarter/year-end and module checklists.
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { ChecklistService } from '../services/checklistService.js';
import { uploadToS3, getFileUrl as s3GetFileUrl } from '../services/s3Service.js';

export const listTemplates = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { type, module } = req.query;
  const service = new ChecklistService(orgId);
  const templates = await service.listTemplates({ type, module });
  res.json({ success: true, data: templates });
});

export const bootstrapModuleCatalogTemplates = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new ChecklistService(orgId);
  const summary = await service.bootstrapComplianceCatalogTemplates();
  res.json({ success: true, data: summary });
});

export const createTemplate = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }
  const orgId = req.orgId;
  const service = new ChecklistService(orgId);
  const created = await service.createTemplate(req.body);
  res.status(201).json({ success: true, data: created });
});

export const updateTemplate = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }
  const orgId = req.orgId;
  const { templateId } = req.params;
  const service = new ChecklistService(orgId);
  const updated = await service.updateTemplate(templateId, req.body);
  res.json({ success: true, data: updated });
});

export const deleteTemplate = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { templateId } = req.params;
  const service = new ChecklistService(orgId);
  await service.deleteTemplate(templateId);
  res.json({ success: true, message: 'Template deleted' });
});

export const listInstances = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new ChecklistService(orgId);
  const instances = await service.listInstances(req.query);
  res.json({ success: true, data: instances });
});

export const createInstance = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }
  const orgId = req.orgId;
  const userId = req.user.userId;
  const service = new ChecklistService(orgId);
  const { type, year, month, quarter } = req.body;
  const instance = await service.createInstanceFromTemplate({ type, year, month, quarter }, userId);
  res.status(201).json({ success: true, data: instance });
});

export const resolveWorkflowInstance = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }
  const orgId = req.orgId;
  const userId = req.user.userId;
  const service = new ChecklistService(orgId);
  const { entityType, entityId, approvalRequestId } = req.body;
  const instance = await service.ensureWorkflowChecklistForApproval({
    entityType,
    entityId,
    approvalRequestId,
    createdBy: userId
  });
  res.json({ success: true, data: instance });
});

export const getInstance = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { instanceId } = req.params;
  const service = new ChecklistService(orgId);
  const instance = await service.getInstance(instanceId);
  res.json({ success: true, data: instance });
});

export const patchInstanceItem = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { instanceId, itemId } = req.params;
  const service = new ChecklistService(orgId);
  const updated = await service.patchItem({ instanceId, itemId }, req.body, userId);
  res.json({ success: true, data: updated });
});

export const closeInstance = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { instanceId } = req.params;
  const service = new ChecklistService(orgId);
  const closed = await service.closeInstance(instanceId, userId);
  res.json({ success: true, data: closed });
});

export const getOverdueSummary = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new ChecklistService(orgId);
  const summary = await service.getOverdueSummary({ limit: req.query.limit });
  res.json({ success: true, data: summary });
});

export const getFinanceSummary = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new ChecklistService(orgId);
  const { type, year, month, quarter } = req.query;
  const summary = await service.getFinancePeriodSummary({ type, year, month, quarter });
  res.json({ success: true, data: summary });
});

/**
 * Upload checklist evidence to S3.
 */
export const uploadEvidence = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: { code: 'FILE_REQUIRED', message: 'File is required' }
    });
  }
  const orgId = req.orgId;
  const { key } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'checklists'
  );
  res.json({
    success: true,
    data: {
      key,
      fileName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype
    }
  });
});

export const getEvidenceFileUrl = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) {
    return res.status(400).json({
      success: false,
      error: { code: 'KEY_REQUIRED', message: 'File key is required' }
    });
  }
  const url = await s3GetFileUrl(key, 3600);
  res.json({ success: true, data: { url } });
});

