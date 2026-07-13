/**
 * Risk Controller
 *
 * HTTP handlers for risk management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { RiskService } from '../services/riskService.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { uploadToS3, getFileStream } from '../services/s3Service.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';
import { setSafeDownloadHeaders } from '../utils/safeDownloadHeaders.js';

/**
 * Check if user can add risk treatment: admin (org owner) or head of department of the risk's department
 */
async function canUserAddTreatment(tenantDb, orgId, risk, userId, userRoles = []) {
  if (!userId) return false;
  const isAdmin = userRoles?.includes('admin');
  if (isAdmin) return true;

  const departmentId = risk.department_id?._id || risk.department_id;
  if (!departmentId) return false;

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) return false;

  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const deptHead = await boardMemberRepo.findDepartmentHeadByDepartmentId(org._id, departmentId);
  if (!deptHead) return false;

  const deptHeadUserId = deptHead.user_id?._id || deptHead.user_id;
  return deptHeadUserId && String(deptHeadUserId) === String(userId);
}

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
  const userId = req.user?.userId;
  const userRoles = req.user?.roles || [];

  const riskService = new RiskService(orgId);
  const risk = await riskService.getRiskById(riskId);

  let canAddTreatment = false;
  if (userId && risk) {
    const tenantDb = await getTenantConnection(orgId);
    canAddTreatment = await canUserAddTreatment(tenantDb, orgId, risk, userId, userRoles);
  }

  const data = risk && typeof risk === 'object'
    ? (risk.toObject ? { ...risk.toObject() } : { ...risk })
    : {};
  data.canAddTreatment = canAddTreatment;

  res.json({
    success: true,
    data
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

/**
 * POST /platform/risks/:riskId/resubmit
 *
 * Resubmit a rejected risk. Optionally accept the same field updates
 * the edit form sends so the user can fix issues in one step rather
 * than editing and then clicking a separate resubmit button.
 */
export const resubmitRisk = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const { riskId } = req.params;
  const updates = (req.body && typeof req.body === 'object') ? req.body : {};
  const riskService = new RiskService(orgId);
  const risk = await riskService.resubmitRisk(riskId, userId, updates);
  res.json({ success: true, data: risk });
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

export const exportRiskPdf = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId } = req.params;

  const riskService = new RiskService(orgId);
  const rawRisk = await riskService.getRiskById(riskId);
  if (!rawRisk) {
    throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
  }

  // Clone so we can safely enhance attachments / treatments
  const risk = rawRisk && typeof rawRisk === 'object'
    ? (rawRisk.toObject ? { ...rawRisk.toObject() } : { ...rawRisk })
    : rawRisk;

  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const logoUrl = org?.logo_url || process.env.LOGO || '';

  // Resolve S3 keys to signed URLs for attachments & evidence
  const { getFileUrl } = await import('../services/s3Service.js');

  const attachments = await Promise.all(
    (risk.attachments || []).map(async (att) => {
      let url = null;
      if (att.file_path) {
        try {
          url = await getFileUrl(att.file_path, 604800);
        } catch {
          url = null;
        }
      }
      return { ...att, url };
    })
  );

  const treatments = await Promise.all(
    (risk.treatments || []).map(async (t) => {
      const evidence = await Promise.all(
        (t.evidence || []).map(async (ev) => {
          let url = null;
          if (ev.file_path) {
            try {
              url = await getFileUrl(ev.file_path, 604800);
            } catch {
              url = null;
            }
          }
          return { ...ev, url };
        })
      );
      return { ...t, evidence };
    })
  );

  const { generateRiskDetailPDF } = await import('../services/riskPdfService.js');
  const buffer = await generateRiskDetailPDF(
    {
      risk: { ...risk, attachments, treatments },
      org
    },
    logoUrl
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="risk-${riskId}.pdf"`);
  res.send(buffer);
});

export const exportRiskRegisterPdf = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    category: req.query.category,
    search: req.query.search
  };

  const riskService = new RiskService(orgId);
  const risks = await riskService.getRisks(filters);

  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const logoUrl = org?.logo_url || process.env.LOGO || '';

  const { generateRiskRegisterPDF } = await import('../services/riskPdfService.js');
  const buffer = await generateRiskRegisterPDF(
    {
      risks,
      org
    },
    logoUrl
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="risk-register.pdf"');
  res.send(buffer);
});

/** Audit-pack ZIP of the risk register: per-risk JSON + attachments + summary CSV. */
export const exportRiskRegisterZip = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    category: req.query.category,
    search: req.query.search
  };

  const riskService = new RiskService(orgId);
  const risks = await riskService.getRisks(filters);

  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const logoUrl = org?.logo_url || process.env.LOGO || '';

  const { streamRisksZip } = await import('../services/riskZipExportService.js');
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="risk-register-${dateStr}.zip"`);
  res.setHeader('Cache-Control', 'no-store');
  await streamRisksZip(risks, res, { orgId, org, logoUrl });
});

/** Add a treatment to a risk - triggers approval workflow */
export const addTreatment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId } = req.params;
  const { control_action, owner, due_date } = req.body;
  const userId = req.user?.userId;
  const userRoles = req.user?.roles || [];

  const tenantDb = await getTenantConnection(orgId);
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(riskId);
  if (!risk) {
    return res.status(404).json({ success: false, error: { message: 'Risk not found' } });
  }

  const allowed = await canUserAddTreatment(tenantDb, orgId, risk, userId, userRoles);
  if (!allowed) {
    return res.status(403).json({
      success: false,
      error: {
        message: 'Only an admin or the head of the risk\'s department can add treatments.',
        code: 'FORBIDDEN_ADD_TREATMENT'
      }
    });
  }

  const updated = await riskRepo.addTreatment(riskId, {
    control_action: control_action || '',
    owner: owner || '',
    due_date: due_date || undefined,
    status: 'pending'
  });

  // Treatment added - now trigger approval workflow if configured
  const treatmentIndex = (updated.treatments?.length || 1) - 1;
  
  try {
    const workflowService = new ApprovalWorkflowService(orgId);
    await workflowService.createRiskTreatmentApprovalRequest(riskId, treatmentIndex, req.user?.userId);
    
    // Return updated risk with status 'under_treatment' (waiting for approval)
    const refreshed = await riskRepo.findById(riskId);
    res.status(201).json({ 
      success: true, 
      data: refreshed,
      message: 'Treatment added and submitted for approval'
    });
  } catch (workflowError) {
    logError('Error creating treatment approval request', { error: workflowError.message, riskId });
    
    // Check if it's a missing workflow configuration error
    const isConfigError = workflowError.code === 'NO_MATCHING_RULE' || 
                          workflowError.code === 'NO_APPROVAL_MATRIX' ||
                          workflowError.message?.includes('No approval');
    
    if (isConfigError) {
      // Return error to prompt user to configure workflow
      return res.status(400).json({ 
        success: false, 
        error: { 
          message: 'Risk Treatment approval workflow not configured. Please create a Risk Treatment workflow in Settings > Roles & Permissions > Workflows.',
          code: 'WORKFLOW_NOT_CONFIGURED'
        }
      });
    }
    
    // For other errors, still add treatment but show warning
    res.status(201).json({ 
      success: true, 
      data: updated,
      warning: 'Treatment added but approval workflow could not be initialized: ' + workflowError.message
    });
  }
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

/** Upload attachment for a risk */
export const addRiskAttachment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId } = req.params;
  if (!req.file) {
    return res.status(400).json({ success: false, error: { message: 'Attachment file is required' } });
  }

  const tenantDb = await getTenantConnection(orgId);
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(riskId);
  if (!risk) {
    return res.status(404).json({ success: false, error: { message: 'Risk not found' } });
  }

  const { key } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'risk_attachment'
  );

  const updated = await riskRepo.addAttachment(riskId, {
    file_path: key,
    file_name: req.file.originalname,
    file_size: req.file.size,
    mime_type: req.file.mimetype
  });

  res.status(201).json({ success: true, data: updated });
});

/** Stream risk attachment file for viewing */
export const streamRiskAttachment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { riskId, attachmentIndex } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const riskRepo = new RiskRepository(tenantDb);
  const risk = await riskRepo.findById(riskId);
  if (!risk) {
    throw new AppError('Risk not found', 404, 'NOT_FOUND');
  }
  const idx = parseInt(attachmentIndex, 10);
  if (isNaN(idx) || idx < 0 || !risk.attachments?.[idx]) {
    throw new AppError('Attachment not found', 404, 'NOT_FOUND');
  }
  const att = risk.attachments[idx];
  if (!att?.file_path) {
    throw new AppError('Attachment not found', 404, 'NOT_FOUND');
  }
  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await getFileStream(att.file_path, rangeHeader);
  setSafeDownloadHeaders(res, { contentType: ContentType, fileName: att.file_name || 'attachment' });
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
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
  setSafeDownloadHeaders(res, { contentType: ContentType, fileName: evidence.file_name || 'evidence' });
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});
