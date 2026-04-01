/**
 * Partner Vetting Controller
 *
 * HTTP handlers for partner vetting management
 */

import { validationResult } from 'express-validator';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PartnerVettingService } from '../services/partnerVettingService.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { AppError } from '../middleware/errorHandler.js';
import { PartnerVettingRepository } from '../repositories/partnerVettingRepository.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { CoiWorkflowService } from '../services/coiWorkflowService.js';
import emailService from '../services/emailService.js';
import { createPartnerActionToken, resolvePartnerActionToken, markPartnerActionTokenUsed } from '../services/partnerActionTokenService.js';

const parsePublicToken = (token, req) => {
  // Expected format: "<orgKey>.<token>"
  const raw = String(token || '').trim();
  const dotIdx = raw.indexOf('.');
  const prefix = dotIdx >= 0 ? raw.slice(0, dotIdx) : '';
  const rest = dotIdx >= 0 ? raw.slice(dotIdx + 1) : '';
  const orgKey = prefix || req?.headers?.['x-org-id'] || null;
  if (!orgKey || !rest) return null;
  return { orgKey, token: rest };
};

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

export const uploadVettingCheckDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId, checkIndex } = req.params;
  if (!req.file) {
    return res.status(400).json({ success: false, error: { message: 'Document file is required' } });
  }

  const index = parseInt(checkIndex, 10);
  if (Number.isNaN(index) || index < 0) {
    return res.status(400).json({ success: false, error: { message: 'Invalid check index' } });
  }

  const service = new PartnerVettingService(orgId);
  const partner = await service.uploadVettingCheckDocument(partnerId, index, req.file);

  res.status(201).json({
    success: true,
    data: partner
  });
});

export const streamVettingCheckDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId, checkIndex, docIndex } = req.params;
  const cIdx = parseInt(checkIndex, 10);
  const dIdx = parseInt(docIndex, 10);
  if (Number.isNaN(cIdx) || cIdx < 0 || Number.isNaN(dIdx) || dIdx < 0) {
    return res.status(400).json({ success: false, error: { message: 'Invalid document index' } });
  }

  const service = new PartnerVettingService(orgId);
  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await service.streamVettingCheckDocument(
    partnerId,
    cIdx,
    dIdx,
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

export const startPartnerCoi = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { partnerId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const repo = new PartnerVettingRepository(tenantDb);
  const partner = await repo.findById(partnerId);
  if (!partner) throw new AppError('Partner not found', 404, 'NOT_FOUND');

  const email = String(partner?.contact?.email || '').trim().toLowerCase();
  if (!email) throw new AppError('Partner contact email is required to start COI', 400, 'PARTNER_EMAIL_REQUIRED');

  // 14 days
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
  const tokenDoc = await createPartnerActionToken({
    orgId,
    partnerId,
    actionType: 'coi',
    email,
    expiresAt,
    metadata: {
      partner_name: partner?.organization_name || partner?.trading_name || '',
      contact_name: partner?.contact?.name || '',
    }
  });

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const publicToken = `${orgId}.${tokenDoc.token}`;
  const link = `${baseUrl}/public/partners/coi/${publicToken}`;

  await emailService.sendPartnerCoiRequestEmail({
    to: email,
    partnerName: partner?.organization_name || partner?.trading_name || '',
    contactName: partner?.contact?.name || '',
    link,
    expiryDate: expiresAt
  });

  res.json({ success: true, data: { sent: true, link } });
});

export const getPublicPartnerCoiContext = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const parsed = parsePublicToken(token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tokenDoc = await resolvePartnerActionToken(parsed.token, 'coi');
  if (!tokenDoc) throw new AppError('Invalid or expired link', 401, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new PartnerVettingRepository(tenantDb);
  const partner = await repo.findById(tokenDoc.partner_id);
  if (!partner) throw new AppError('Partner not found', 404, 'NOT_FOUND');

  res.json({
    success: true,
    data: {
      partner: {
        id: partner._id,
        name: partner.organization_name || partner.trading_name || '',
        contact_name: partner?.contact?.name || '',
        contact_email: partner?.contact?.email || '',
      },
      token: tokenDoc.token,
      expires_at: tokenDoc.expires_at || null
    }
  });
});

export const submitPublicPartnerCoi = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  const { token } = req.params;
  const parsed = parsePublicToken(token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tokenDoc = await resolvePartnerActionToken(parsed.token, 'coi');
  if (!tokenDoc) throw new AppError('Invalid or expired link', 401, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const partnerRepo = new PartnerVettingRepository(tenantDb);
  const partner = await partnerRepo.findById(tokenDoc.partner_id);
  if (!partner) throw new AppError('Partner not found', 404, 'NOT_FOUND');

  // Resolve COI workflow matrix / rule
  const orgRepo = (await import('../repositories/organizationRepository.js')).OrganizationRepository;
  const OrganizationRepository = orgRepo;
  const oRepo = new OrganizationRepository(tenantDb);
  const org = await oRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const matrixRepo = new ApprovalMatrixRepository(tenantDb);
  const matrices = await matrixRepo.findByOrgId(org._id);
  const coiMatrix = matrices?.find((m) => m.rules?.some((r) => r.action_type === 'coi' && r.is_active));
  if (!coiMatrix) throw new AppError('COI approval workflow not configured. Please configure COI workflow in settings.', 400, 'NO_COI_MATRIX');
  const coiRule = coiMatrix.rules.find((r) => r.action_type === 'coi' && r.is_active);
  if (!coiRule) throw new AppError('No active COI rule found in approval matrix.', 400, 'NO_COI_RULE');

  const workflowService = new CoiWorkflowService(parsed.orgKey);
  const approvers = await workflowService.resolveApprovers(coiRule, null);
  const approvalSteps = approvers.map((a) => ({
    level: a.level,
    approver_user_id: a.user_id,
    approver_position_id: a.position_id,
    approver_department_id: a.department_id,
    status: 'pending'
  }));

  const coiRepo = new CoiRequestRepository(tenantDb);
  const externalCoi = await coiRepo.create({
    org_id: org._id,
    submission_source: 'external',
    is_external: true,
    external_submitter: {
      name: req.body.external_submitter?.name || partner?.contact?.name || 'Partner',
      email: req.body.external_submitter?.email || tokenDoc.email || partner?.contact?.email || null,
      phone: req.body.external_submitter?.phone || null
    },
    coi_reason: req.body.coi_reason,
    conflict_person_name: req.body.conflict_person_name,
    conflict_person_details: req.body.conflict_person_details,
    approval_matrix_id: coiMatrix._id,
    approval_type: coiRule.approval_type || 'sequential',
    approval_steps: approvalSteps,
    parent_approval_request_id: null,
    parent_step_index: null,
    parent_entity_id: partner._id,
    parent_entity_type: 'partner_vetting',
    submitted_by: null,
    status: 'pending'
  });

  await markPartnerActionTokenUsed(tokenDoc.token);

  res.status(201).json({
    success: true,
    message: 'Conflict of interest submitted successfully. Our team will review it shortly.',
    data: { id: externalCoi._id }
  });
});
