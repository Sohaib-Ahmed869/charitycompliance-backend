/**
 * Project delivery / handoff controller
 *
 * Provides:
 * - Internal endpoints (auth required) to list refund + delivery change records per project.
 * - Public “partner” endpoints (token-based, no auth) to store refund receipts/explanations.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ProjectRefundRepository } from '../repositories/projectRefundRepository.js';
import { ProjectDeliveryChangeRepository } from '../repositories/projectDeliveryChangeRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ProjectRegisterRepository } from '../repositories/projectRegisterRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import emailService from '../services/emailService.js';
import { uploadToS3 } from '../services/s3Service.js';
import { AppError } from '../middleware/errorHandler.js';
import crypto from 'crypto';

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

export const listProjectRefunds = asyncHandler(async (req, res) => {
  const { projectId } = req.query;
  const tenantDb = await getTenantConnection(req.orgId);
  const repo = new ProjectRefundRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const orgId = org?._id;

  const records = await repo.findByOrgId(orgId, projectId || null);
  res.json({ success: true, data: records || [] });
});

export const listProjectDeliveryChanges = asyncHandler(async (req, res) => {
  const { projectId } = req.query;
  const tenantDb = await getTenantConnection(req.orgId);
  const repo = new ProjectDeliveryChangeRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const orgId = org?._id;

  const records = await repo.findByOrgId(orgId, projectId || null);
  res.json({ success: true, data: records || [] });
});

export const submitRefundPartnerResponse = asyncHandler(async (req, res) => {
  const { token } = req.params;

  const parsed = parsePublicToken(token, req);
  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or missing token' }
    });
  }

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new ProjectRefundRepository(tenantDb);
  const record = await repo.findByToken(parsed.token, parsed.orgKey);
  if (!record) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Refund token not found' }
    });
  }

  // Basic validation / normalization
  const notes = String(req.body?.notes || req.body?.explanation || req.body?.admin_notes || '').trim();
  const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];

  const normalizedReceipts = receipts
    .map((r) => ({
      file_name: String(r?.file_name || r?.fileName || r?.name || '').trim(),
      data_url: String(r?.data_url || r?.dataUrl || r?.data || '').trim()
    }))
    .filter((r) => r.file_name || r.data_url);

  const updated = await repo.updateById(record._id, {
    status: 'partner_receipts_submitted',
    partner_submission: {
      submitted_at: new Date(),
      notes: notes || '',
      receipts: normalizedReceipts
    }
  });

  // Create internal refunds workflow after partner submission (store-only first).
  try {
    let approvalRequestId = record.internal_approval_request_id || null;
    if (!approvalRequestId) {
      if (!record.initiated_by) {
        throw new AppError(
          'Refund process has not been initiated yet',
          400,
          'REFUND_NOT_INITIATED'
        );
      }
      const workflowService = new ApprovalWorkflowService(parsed.orgKey);
      const created = await workflowService.createProjectRefundApprovalRequest(
        record.project_id,
        Number(record.refund_amount || 0),
        record.initiated_by
      );
      approvalRequestId = created?._id || null;
      if (approvalRequestId) {
        await repo.updateById(record._id, { internal_approval_request_id: approvalRequestId });
      }
    }

    // Notify internal approvers (if workflow request exists)
    if (approvalRequestId) {
      const approvalRepo = new ApprovalRequestRepository(tenantDb);
      const approval = await approvalRepo.findById(approvalRequestId);
      const userIds = new Set();
      (approval?.approval_steps || []).forEach((s) => {
        const uid = s?.approver_user_id?._id || s?.approver_user_id;
        if (uid) userIds.add(String(uid));
      });

      if (userIds.size > 0) {
        const notificationRepo = new NotificationRepository(tenantDb);
        await notificationRepo.createMany(
          [...userIds].map((uid) => ({
            user_id: uid,
            type: 'project_refund_partner_receipts_submitted',
            title: 'Refund receipts submitted',
            message: 'A partner has submitted refund receipts. Please review and approve the refund workflow.',
            link: `/approvals/${approvalRequestId}`,
            related_entity_id: approvalRequestId,
            related_entity_type: 'approval_request',
            read: false,
            created_at: new Date()
          }))
        );
      }
    }
  } catch (_) {
    // Do not fail partner submission if notifications fail
  }

  res.json({ success: true, data: updated });
});

export const initiateRefundProcess = asyncHandler(async (req, res) => {
  const { refundId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const repo = new ProjectRefundRepository(tenantDb);
  const refund = await repo.ProjectRefund.findById(refundId).populate('agreement_id').lean();
  if (!refund) throw new AppError('Refund record not found', 404, 'REFUND_NOT_FOUND');

  if (refund.status === 'completed') {
    throw new AppError('Refund is already completed', 400, 'REFUND_ALREADY_COMPLETED');
  }

  const projIdEarly = refund.project_id?._id || refund.project_id;
  const ProjectRegisterModel = tenantDb.model('ProjectRegister');
  const linkedProject = projIdEarly ? await ProjectRegisterModel.findById(projIdEarly).lean() : null;
  const isInternalRefundProject = String(linkedProject?.project_kind || '') === 'internal';

  if (isInternalRefundProject && refund.status === 'pending_initiation') {
    const updated = await repo.updateById(refundId, {
      status: 'partner_receipts_submitted',
      initiated_at: new Date(),
      initiated_by: req.user?.userId || req.userId || null,
      partner_contact_email: '',
      partner_submission: {
        submitted_at: new Date(),
        notes: 'Internal project — surplus recorded in-house (no external partner refund form).',
        receipts: []
      }
    });
    return res.json({ success: true, data: updated });
  }

  // If partner already submitted receipts but the internal approval workflow was not created (older runs),
  // allow "initiate" to create the approval workflow without re-sending partner emails.
  if (refund.status === 'partner_receipts_submitted') {
    let approvalRequestId = refund.internal_approval_request_id || null;
    if (!approvalRequestId) {
      const workflowService = new ApprovalWorkflowService(req.orgId);
      const created = await workflowService.createProjectRefundApprovalRequest(
        refund.project_id?._id || refund.project_id,
        Number(refund.refund_amount || 0),
        req.user?.userId || req.userId || refund.initiated_by || null
      );
      approvalRequestId = created?._id || null;
      if (approvalRequestId) {
        const updated = await repo.updateById(refundId, { internal_approval_request_id: approvalRequestId });
        return res.json({ success: true, data: updated });
      }
    }
    return res.json({ success: true, data: refund });
  }

  const agreement = refund.agreement_id || null;
  let partnerEmail =
    agreement?.metadata?.partner_email ||
    agreement?.metadata?.partnerEmail ||
    agreement?.metadata?.contact_email ||
    agreement?.partner_email ||
    '';

  // Prefer partner vetting primary contact email.
  const partnerNameRaw =
    agreement?.partner_name ||
    agreement?.metadata?.partner_name ||
    agreement?.metadata?.partnerName ||
    '';

  if (!partnerEmail && partnerNameRaw) {
    try {
      const partnerVettingSchema = (await import('../db/schemas/platform/partnerVettingSchema.js')).default;
      const PartnerVetting = tenantDb.models.PartnerVetting || tenantDb.model('PartnerVetting', partnerVettingSchema);
      const escRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const name = String(partnerNameRaw || '').trim();
      const rx = new RegExp(`^${escRegex(name)}$`, 'i');
      const partner = await PartnerVetting.findOne({
        status: 'approved',
        $or: [
          { organization_name: rx },
          { trading_name: rx },
          { 'metadata.organization_name': rx },
          { 'metadata.trading_name': rx }
        ]
      }).sort({ updatedAt: -1, createdAt: -1 }).lean();
      if (partner?.contact?.email) partnerEmail = String(partner.contact.email).trim();
    } catch (_) {
      // Ignore and continue with fallback values.
    }
  }

  if (!partnerEmail || !String(partnerEmail).includes('@')) {
    throw new AppError(
      'Partner primary contact email is required in Partner Vetting before initiating refund process',
      400,
      'PARTNER_PRIMARY_CONTACT_EMAIL_REQUIRED'
    );
  }

  const formLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/projects/refunds/${req.orgId}.${refund.token}`;
  await emailService.sendProjectRefundExternalFormEmail({
    to: partnerEmail,
    recipientName: agreement?.partner_name || 'Partner',
    projectName: refund?.project_id?.project_name || 'Project',
    refundAmount: refund.refund_amount,
    formLink
  });

  const updated = await repo.updateById(refundId, {
    status: 'awaiting_partner_receipts',
    initiated_at: new Date(),
    initiated_by: req.user?.userId || req.userId || null,
    partner_contact_email: partnerEmail
  });

  res.json({ success: true, data: updated });
});

/**
 * Internal: close refund + close project after partner receipts submitted, using direct e-signature (no workflow).
 * POST /platform/project-delivery/refunds/:refundId/close
 */
export const closeRefundAndProject = asyncHandler(async (req, res) => {
  const { refundId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const refundRepo = new ProjectRefundRepository(tenantDb);
  const projectRepo = new ProjectRegisterRepository(tenantDb);

  const refund = await refundRepo.ProjectRefund.findById(refundId).lean();
  if (!refund) throw new AppError('Refund record not found', 404, 'REFUND_NOT_FOUND');

  const status = String(refund.status || '').toLowerCase();
  if (status === 'completed') {
    return res.json({ success: true, data: refund });
  }
  if (status !== 'partner_receipts_submitted') {
    throw new AppError('Refund cannot be closed until partner receipts are submitted', 400, 'REFUND_NOT_READY_TO_CLOSE');
  }

  const signature = String(req.body?.signature_data_url || '').trim();
  if (!signature) {
    throw new AppError('signature_data_url is required', 400, 'MISSING_SIGNATURE');
  }
  const note = String(req.body?.note || '').trim();

  const now = new Date();
  const userId = req.user?.userId || req.userId || null;

  const updatedRefund = await refundRepo.updateById(refundId, {
    status: 'completed',
    completed_at: now,
    completed_by: userId,
    completed_note: note,
    completed_signature_data: signature,
    internal_approved_at: refund.internal_approved_at || now
  });

  const projectId = refund.project_id?._id || refund.project_id;
  const project = projectId ? await projectRepo.findById(projectId) : null;
  if (project) {
    const meta = project.metadata && typeof project.metadata === 'object' ? project.metadata : {};
    await projectRepo.update(projectId, {
      status: 'closed',
      delivery_status: 'delivered_and_handed_off',
      metadata: {
        ...meta,
        project_closed_at: now,
        project_closed_via: 'refund_direct_signoff',
        project_closed_by: userId,
        refund_completed_at: now,
        refund_id: refundId
      }
    });
  }

  res.json({ success: true, data: updatedRefund });
});

export const submitDeliveryChangePartnerResponse = asyncHandler(async (req, res) => {
  const { token } = req.params;

  const parsed = parsePublicToken(token, req);
  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or missing token' }
    });
  }

  const tenantDb = await getTenantConnection(parsed.orgKey);

  const repo = new ProjectDeliveryChangeRepository(tenantDb);
  const record = await repo.findByToken(parsed.token, parsed.orgKey);
  if (!record) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Delivery change token not found' }
    });
  }

  const notes = String(req.body?.notes || req.body?.explanation || req.body?.partner_notes || '').trim();
  const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];

  const normalizedReceipts = receipts
    .map((r) => ({
      file_name: String(r?.file_name || r?.fileName || r?.name || '').trim(),
      data_url: String(r?.data_url || r?.dataUrl || r?.data || '').trim()
    }))
    .filter((r) => r.file_name || r.data_url);

  const updated = await repo.updateById(record._id, {
    status: 'partner_explanation_submitted',
    partner_submission: {
      submitted_at: new Date(),
      notes: notes || '',
      receipts: normalizedReceipts
    }
  });

  // Notify internal approvers (if workflow request exists)
  try {
    if (record.internal_approval_request_id) {
      const approvalRepo = new ApprovalRequestRepository(tenantDb);
      const approval = await approvalRepo.findById(record.internal_approval_request_id);
      const userIds = new Set();
      (approval?.approval_steps || []).forEach((s) => {
        const uid = s?.approver_user_id?._id || s?.approver_user_id;
        if (uid) userIds.add(String(uid));
      });

      if (userIds.size > 0) {
        const notificationRepo = new NotificationRepository(tenantDb);
        await notificationRepo.createMany(
          [...userIds].map((uid) => ({
            user_id: uid,
            type: 'project_delivery_changes_partner_explanation_submitted',
            title: 'Budget exceed explanation submitted',
            message: 'A partner has submitted the explanation and attachments for delivery changes. Please review and approve the workflow.',
            link: `/approvals/${record.internal_approval_request_id}`,
            related_entity_id: record.internal_approval_request_id,
            related_entity_type: 'approval_request',
            read: false,
            created_at: new Date()
          }))
        );
      }
    }
  } catch (_) {
    // Ignore notification errors for partner submission
  }

  res.json({ success: true, data: updated });
});

const normalizeDataUrlFiles = (files) => {
  const arr = Array.isArray(files) ? files : [];
  return arr
    .map((f) => ({
      file_name: String(f?.file_name || f?.fileName || f?.name || '').trim(),
      data_url: String(f?.data_url || f?.dataUrl || f?.data || '').trim()
    }))
    .filter((f) => f.file_name || f.data_url);
};

export const submitProgressReportPartnerResponse = asyncHandler(async (req, res) => {
  const { token } = req.params;

  const parsed = parsePublicToken(token, req);
  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or missing token' }
    });
  }

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.ProjectRegister.findOne({
    'metadata.partner_progress_reports': { $elemMatch: { token: parsed.token } }
  }).lean();

  if (!project) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Progress report token not found' }
    });
  }

  const reports = Array.isArray(project?.metadata?.partner_progress_reports)
    ? project.metadata.partner_progress_reports
    : [];
  const idx = reports.findIndex((r) => String(r?.token || '') === String(parsed.token));
  if (idx < 0) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Progress report token not found' }
    });
  }

  const report = reports[idx] || {};
  if (report?.partner_submission?.submitted_at) {
    return res.status(400).json({
      success: false,
      error: { code: 'ALREADY_SUBMITTED', message: 'This progress report has already been submitted' }
    });
  }

  const notes = String(req.body?.notes || '').trim();
  const attachments_report = normalizeDataUrlFiles(req.body?.attachments_report || req.body?.attachments || []);
  const attachments_media_report = normalizeDataUrlFiles(req.body?.attachments_media_report || []);
  const attachments_media = normalizeDataUrlFiles(req.body?.attachments_media || []);

  const nextReports = [...reports];
  nextReports[idx] = {
    ...report,
    status: 'partner_submitted',
    partner_submission: {
      submitted_at: new Date(),
      notes: notes || '',
      attachments_report,
      attachments_media_report,
      attachments_media,
      // Back-compat for older UI: keep a flat list too.
      attachments: attachments_report,
    }
  };

  const updated = await projectRepo.update(project._id, {
    metadata: {
      ...(project.metadata || {}),
      partner_progress_reports: nextReports
    }
  });

  res.json({ success: true, data: updated });
});

const resolvePartnerEmailFromAgreement = async (tenantDb, agreement, reqOrgId) => {
  let partnerEmail =
    agreement?.metadata?.partner_email ||
    agreement?.metadata?.partnerEmail ||
    agreement?.metadata?.contact_email ||
    agreement?.partner_email ||
    '';

  const partnerNameRaw =
    agreement?.partner_name ||
    agreement?.metadata?.partner_name ||
    agreement?.metadata?.partnerName ||
    '';

  if (!partnerEmail && partnerNameRaw) {
    try {
      const partnerVettingSchema = (await import('../db/schemas/platform/partnerVettingSchema.js')).default;
      const PartnerVetting = tenantDb.models.PartnerVetting || tenantDb.model('PartnerVetting', partnerVettingSchema);
      const escRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const name = String(partnerNameRaw || '').trim();
      const rx = new RegExp(`^${escRegex(name)}$`, 'i');
      const partner = await PartnerVetting.findOne({
        status: 'approved',
        $or: [
          { organization_name: rx },
          { trading_name: rx },
          { 'metadata.organization_name': rx },
          { 'metadata.trading_name': rx }
        ]
      }).sort({ updatedAt: -1, createdAt: -1 }).lean();
      if (partner?.contact?.email) partnerEmail = String(partner.contact.email).trim();
    } catch (_) {
      // ignore
    }
  }

  if (!partnerEmail || !String(partnerEmail).includes('@')) {
    throw new AppError(
      'Partner primary contact email is required in Partner Vetting before requesting progress reports',
      400,
      'PARTNER_PRIMARY_CONTACT_EMAIL_REQUIRED'
    );
  }

  return partnerEmail;
};

export const initiatePartnerProgressReport = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const reportType = String(req.body?.report_type || 'interim').toLowerCase() === 'final' ? 'final' : 'interim';

  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  if (String(project.project_kind || '') === 'internal') {
    throw new AppError(
      'Internal projects do not use partner email links. Add a progress report using the staff upload action in Project Monitoring.',
      400,
      'INTERNAL_PROJECT_NO_PARTNER_REPORT'
    );
  }

  const FundingAgreement = tenantDb.model('FundingAgreement');
  const agreement = project.agreement_id ? await FundingAgreement.findById(project.agreement_id).lean() : null;
  const partnerEmail = await resolvePartnerEmailFromAgreement(tenantDb, agreement, req.orgId);

  const reportToken = crypto.randomBytes(24).toString('hex');
  const id = crypto.randomBytes(10).toString('hex');

  const reports = Array.isArray(project?.metadata?.partner_progress_reports)
    ? [...project.metadata.partner_progress_reports]
    : [];
  reports.unshift({
    id,
    token: reportToken,
    report_type: reportType,
    status: 'requested',
    requested_at: new Date(),
    requested_by: req.user?.userId || req.userId || null
  });

  const updated = await projectRepo.update(projectId, {
    metadata: {
      ...(project.metadata || {}),
      partner_progress_reports: reports
    }
  });

  const formLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/projects/progress-reports/${req.orgId}.${reportToken}`;
  try {
    await emailService.sendProjectProgressReportExternalFormEmail({
      to: partnerEmail,
      recipientName: agreement?.partner_name || 'Partner',
      projectName: project.project_name || 'Project',
      reportType,
      formLink
    });
  } catch (_) {
    // non-fatal: the request is still created even if email fails
  }

  res.json({ success: true, data: updated });
});

/**
 * Staff-uploaded interim/final progress report for internal projects (no partner / no public link).
 * Reuses the same metadata list and vetting flow as partner reports.
 */
export const submitInternalProgressReport = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const reportType = String(req.body?.report_type || 'interim').toLowerCase() === 'final' ? 'final' : 'interim';
  const notes = String(req.body?.notes || '').trim();
  const attachments_report = normalizeDataUrlFiles(req.body?.attachments_report || req.body?.attachments || []);
  const attachments_media_report = normalizeDataUrlFiles(req.body?.attachments_media_report || []);
  const attachments_media = normalizeDataUrlFiles(req.body?.attachments_media || []);
  if (attachments_report.length === 0) {
    throw new AppError('At least one file attachment is required', 400, 'ATTACHMENTS_REQUIRED');
  }

  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
  if (String(project.project_kind || '') !== 'internal') {
    throw new AppError(
      'Staff progress uploads are only for internal projects. For funded projects, request a partner report instead.',
      400,
      'NOT_INTERNAL_PROJECT'
    );
  }

  const id = crypto.randomBytes(10).toString('hex');
  const reports = Array.isArray(project?.metadata?.partner_progress_reports)
    ? [...project.metadata.partner_progress_reports]
    : [];
  const userId = req.user?.userId || req.userId || null;
  reports.unshift({
    id,
    report_type: reportType,
    status: 'partner_submitted',
    source: 'internal',
    requested_at: new Date(),
    requested_by: userId,
    partner_submission: {
      submitted_at: new Date(),
      notes,
      attachments_report,
      attachments_media_report,
      attachments_media,
      // Back-compat
      attachments: attachments_report,
    }
  });

  const updated = await projectRepo.update(projectId, {
    metadata: {
      ...(project.metadata || {}),
      partner_progress_reports: reports
    }
  });

  res.json({ success: true, data: updated });
});

export const vetPartnerProgressReport = asyncHandler(async (req, res) => {
  const { projectId, reportId } = req.params;
  const vetted = !!req.body?.vetted;
  const vettingNotes = String(req.body?.vetting_notes || '').trim();

  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  const reports = Array.isArray(project?.metadata?.partner_progress_reports)
    ? [...project.metadata.partner_progress_reports]
    : [];
  const idx = reports.findIndex((r) => String(r?.id || r?._id || '') === String(reportId));
  if (idx < 0) throw new AppError('Progress report not found', 404, 'PROGRESS_REPORT_NOT_FOUND');

  reports[idx] = {
    ...(reports[idx] || {}),
    vetting: {
      vetted,
      vetting_notes: vettingNotes,
      vetted_at: new Date(),
      vetted_by: req.user?.userId || req.userId || null
    }
  };

  const updated = await projectRepo.update(projectId, {
    metadata: {
      ...(project.metadata || {}),
      partner_progress_reports: reports
    }
  });

  res.json({ success: true, data: updated });
});

export const setPhysicalMonitoring = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
  if (project.delivery_status === 'delivered_and_handed_off' || project.status === 'closed') {
    throw new AppError('Project is closed and cannot be updated', 403, 'PROJECT_CLOSED_IMMUTABLE');
  }

  const current = project.metadata || {};
  const next = {
    ...(current || {}),
    physical_monitoring: {
      conducted: !!req.body?.conducted,
      conducted_by_name: String(req.body?.conducted_by_name || '').trim(),
      conducted_by_role: String(req.body?.conducted_by_role || '').trim(),
      signoff_name: String(req.body?.signoff_name || '').trim(),
      signoff_title: String(req.body?.signoff_title || '').trim(),
      signature_data_url: String(req.body?.signature_data_url || '').trim(),
      updated_at: new Date(),
      updated_by: req.user?.userId || req.userId || null
    }
  };

  const updated = await projectRepo.update(projectId, { metadata: next });
  res.json({ success: true, data: updated });
});

/**
 * Internal: submit project completion materials (e.g. acquittal reports).
 * If all expenses are paid and materials are provided, this will create
 * the `project_delivery` approval workflow (and keep the project unlockable
 * until it is completed).
 */
export const submitProjectDeliveryMaterials = asyncHandler(async (req, res) => {
  const { projectId } = req.params;

  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);

  const project = await projectRepo.findById(projectId);
  if (!project) {
    throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
  }

  if (project.delivery_status === 'delivered_and_handed_off' || project.status === 'closed') {
    throw new AppError('Project delivery is completed and materials cannot be updated', 403, 'PROJECT_DELIVERY_IMMUTABLE');
  }

  const userId = req.user?.userId || req.userId;
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  const alreadyReady = !!project.metadata?.delivery_materials_ready;
  if (!alreadyReady && files.length === 0) {
    throw new AppError('At least one acquittal document is required', 400, 'AQUITTAL_DOC_REQUIRED');
  }

  const normalizedFiles = files
    .map((f) => ({
      name: String(f?.file_name || f?.name || '').trim(),
      url: String(f?.url || '').trim(),
      key: String(f?.key || '').trim(),
      size: Number(f?.size || 0),
      type: String(f?.type || f?.file_type || '').trim()
    }))
    .filter((f) => f.name && f.url);

  if (!alreadyReady && normalizedFiles.length === 0) {
    throw new AppError(
      'At least one acquittal document must include a valid URL. Please re-upload the acquittal pack.',
      400,
      'AQUITTAL_DOC_REQUIRED'
    );
  }

  const existingFiles = Array.isArray(project?.metadata?.delivery_materials?.files)
    ? project.metadata.delivery_materials.files
    : [];
  const mergedFiles = [...existingFiles, ...normalizedFiles].reduce((acc, f) => {
    const key = String(f?.key || f?.url || f?.name || '').trim();
    if (!key) return acc;
    if (acc._seen.has(key)) return acc;
    acc._seen.add(key);
    acc.files.push(f);
    return acc;
  }, { _seen: new Set(), files: [] }).files;

  const newMetadata = {
    ...(project.metadata || {}),
    delivery_materials_ready: alreadyReady || mergedFiles.length > 0,
    delivery_materials_submitted_at: new Date(),
    // Store the S3 upload references here (URLs + keys).
    delivery_materials: {
      files: mergedFiles
    }
  };

  let updatedProject = await projectRepo.update(projectId, { metadata: newMetadata });

  // Only create project_delivery approval workflow after:
  // - all expenses are paid
  // - remaining budget is 0 (budget fully used)
  const expenseRepo = new ExpenseRepository(tenantDb);
  const readiness = await expenseRepo.getProjectDeliveryReadiness(projectId);
  const totalRelevant = Number(readiness?.totalRelevant || 0);
  const paidRelevant = Number(readiness?.paidRelevant || 0);
  const paidTotal = Number(readiness?.paidAmount || 0);

  const FundingAgreement = tenantDb.model('FundingAgreement');
  const agreement = updatedProject.agreement_id ? await FundingAgreement.findById(updatedProject.agreement_id) : null;
  const budget = Number(agreement?.total_amount || 0);
  const remaining = Math.max(0, budget - paidTotal);

  let createdApprovalRequest = null;
  if (
    totalRelevant > 0 &&
    paidRelevant === totalRelevant &&
    (budget <= 0 || remaining === 0) &&
    updatedProject.delivery_status !== 'in_progress'
  ) {
    const workflowService = new ApprovalWorkflowService(req.orgId);
    createdApprovalRequest = await workflowService.createProjectDeliveryCompletionRequest(projectId, userId);
  }

  if (createdApprovalRequest?._id) {
    updatedProject = await projectRepo.update(projectId, {
      metadata: {
        ...(updatedProject.metadata || {}),
        delivery_approval_request_id: createdApprovalRequest._id
      }
    });
  }

  res.json({
    success: true,
    data: {
      project: updatedProject,
      deliveryApprovalRequestId: createdApprovalRequest?._id || null
    }
  });
});

export const submitProjectDeliveryMaterialsMultipart = asyncHandler(async (req, res) => {
  const { projectId } = req.params;

  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);

  const project = await projectRepo.findById(projectId);
  if (!project) {
    throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
  }

  if (project.delivery_status === 'delivered_and_handed_off' || project.status === 'closed') {
    throw new AppError('Project delivery is completed and materials cannot be updated', 403, 'PROJECT_DELIVERY_IMMUTABLE');
  }

  const userId = req.user?.userId || req.userId;
  const alreadyReady = !!project.metadata?.delivery_materials_ready;

  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  if (!alreadyReady && uploadedFiles.length === 0) {
    throw new AppError('At least one acquittal document is required', 400, 'AQUITTAL_DOC_REQUIRED');
  }

  const normalizedFiles = [];
  for (const f of uploadedFiles) {
    const fileName = String(f?.originalname || '').trim() || 'file';
    const mimeType = String(f?.mimetype || '').trim() || 'application/octet-stream';
    const size = Number(f?.size || 0);
    if (!f?.buffer) continue;
    const up = await uploadToS3(f.buffer, fileName, mimeType, req.orgId, 'delivery_materials');
    normalizedFiles.push({
      name: fileName,
      url: String(up?.url || '').trim(),
      key: String(up?.key || '').trim(),
      size,
      type: mimeType
    });
  }

  if (!alreadyReady && normalizedFiles.length === 0) {
    throw new AppError(
      'At least one acquittal document must include a valid URL. Please re-upload the acquittal pack.',
      400,
      'AQUITTAL_DOC_REQUIRED'
    );
  }

  const existingFiles = Array.isArray(project?.metadata?.delivery_materials?.files)
    ? project.metadata.delivery_materials.files
    : [];
  const mergedFiles = [...existingFiles, ...normalizedFiles].reduce((acc, f) => {
    const key = String(f?.key || f?.url || f?.name || '').trim();
    if (!key) return acc;
    if (acc._seen.has(key)) return acc;
    acc._seen.add(key);
    acc.files.push(f);
    return acc;
  }, { _seen: new Set(), files: [] }).files;

  const newMetadata = {
    ...(project.metadata || {}),
    delivery_materials_ready: alreadyReady || mergedFiles.length > 0,
    delivery_materials_submitted_at: new Date(),
    delivery_materials: {
      files: mergedFiles
    }
  };

  let updatedProject = await projectRepo.update(projectId, { metadata: newMetadata });

  const expenseRepo = new ExpenseRepository(tenantDb);
  const readiness = await expenseRepo.getProjectDeliveryReadiness(projectId);
  const totalRelevant = Number(readiness?.totalRelevant || 0);
  const paidRelevant = Number(readiness?.paidRelevant || 0);
  const paidTotal = Number(readiness?.paidAmount || 0);

  const FundingAgreement = tenantDb.model('FundingAgreement');
  const agreement = updatedProject.agreement_id ? await FundingAgreement.findById(updatedProject.agreement_id) : null;
  const budget = Number(agreement?.total_amount || 0);
  const remaining = Math.max(0, budget - paidTotal);

  let createdApprovalRequest = null;
  if (
    totalRelevant > 0 &&
    paidRelevant === totalRelevant &&
    (budget <= 0 || remaining === 0) &&
    updatedProject.delivery_status !== 'in_progress'
  ) {
    const workflowService = new ApprovalWorkflowService(req.orgId);
    createdApprovalRequest = await workflowService.createProjectDeliveryCompletionRequest(projectId, userId);
  }

  if (createdApprovalRequest?._id) {
    updatedProject = await projectRepo.update(projectId, {
      metadata: {
        ...(updatedProject.metadata || {}),
        delivery_approval_request_id: createdApprovalRequest._id
      }
    });
  }

  res.json({
    success: true,
    data: {
      project: updatedProject,
      deliveryApprovalRequestId: createdApprovalRequest?._id || null
    }
  });
});

export const addProjectUpdateEntry = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  const normalizedFiles = files
    .map((f) => ({
      name: String(f?.name || f?.file_name || '').trim(),
      url: String(f?.url || '').trim(),
      key: String(f?.key || '').trim(),
      size: Number(f?.size || 0),
      type: String(f?.type || '').trim()
    }))
    .filter((f) => f.name && f.url);

  const updates = Array.isArray(project?.metadata?.project_updates)
    ? [...project.metadata.project_updates]
    : [];

  updates.unshift({
    id: crypto.randomBytes(10).toString('hex'),
    entry_date: req.body?.entry_date ? new Date(req.body.entry_date) : new Date(),
    title: String(req.body?.title || '').trim(),
    entry_type: String(req.body?.entry_type || 'report').trim().toLowerCase() === 'media' ? 'media' : 'report',
    notes: String(req.body?.notes || '').trim(),
    files: normalizedFiles,
    created_at: new Date(),
    created_by: req.user?.userId || req.userId || null
  });

  const updated = await projectRepo.update(projectId, {
    metadata: {
      ...(project.metadata || {}),
      project_updates: updates
    }
  });

  res.json({ success: true, data: updated });
});

export const addProjectUpdateEntryMultipart = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const normalizedFiles = [];

  for (const f of uploadedFiles) {
    const fileName = String(f?.originalname || '').trim() || 'file';
    const mimeType = String(f?.mimetype || '').trim() || 'application/octet-stream';
    const size = Number(f?.size || 0);
    if (!f?.buffer || !fileName) continue;
    const up = await uploadToS3(f.buffer, fileName, mimeType, req.orgId, 'project_updates');
    normalizedFiles.push({
      name: fileName,
      url: String(up?.url || '').trim(),
      key: String(up?.key || '').trim(),
      size,
      type: mimeType
    });
  }

  const updates = Array.isArray(project?.metadata?.project_updates)
    ? [...project.metadata.project_updates]
    : [];

  updates.unshift({
    id: crypto.randomBytes(10).toString('hex'),
    entry_date: new Date(),
    title: String(req.body?.title || '').trim(),
    entry_type: String(req.body?.entry_type || 'report').trim().toLowerCase() === 'media' ? 'media' : 'report',
    notes: String(req.body?.notes || '').trim(),
    files: normalizedFiles,
    created_at: new Date(),
    created_by: req.user?.userId || req.userId || null
  });

  const updated = await projectRepo.update(projectId, {
    metadata: {
      ...(project.metadata || {}),
      project_updates: updates
    }
  });

  res.json({ success: true, data: updated });
});

export const addProjectExtraExpense = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  if (project.delivery_status === 'delivered_and_handed_off') {
    throw new AppError('Project already delivered and handed off', 400, 'PROJECT_ALREADY_COMPLETED');
  }

  const amount = Number(req.body?.amount || 0);
  if (!(amount > 0)) {
    throw new AppError('Extra expense amount must be greater than 0', 400, 'INVALID_EXTRA_EXPENSE_AMOUNT');
  }

  const adminDetails = String(req.body?.admin_details || '').trim();
  if (!adminDetails) {
    throw new AppError('Extra expense details are required', 400, 'EXTRA_EXPENSE_DETAILS_REQUIRED');
  }

  const dcRepo = new ProjectDeliveryChangeRepository(tenantDb);
  const existingActive = await dcRepo.findActiveByProjectId(projectId);
  if (existingActive && existingActive.status !== 'completed') {
    throw new AppError(
      'There is already an extra expense request pending approval for this project',
      400,
      'PROJECT_EXTRA_EXPENSE_PENDING'
    );
  }

  const workflowService = new ApprovalWorkflowService(req.orgId);
  const approvalRequest = await workflowService.createProjectDeliveryChangesApprovalRequest(
    projectId,
    amount,
    req.user?.userId || req.userId
  );

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();

  const dcRecord = await dcRepo.create({
    org_key: req.orgId,
    org_id: org?._id,
    project_id: projectId,
    agreement_id: project.agreement_id || null,
    token: crypto.randomBytes(24).toString('hex'),
    over_budget_amount: amount,
    admin_details: adminDetails,
    // For internal extra-expense requests, submission is already provided by admin.
    status: 'partner_explanation_submitted',
    partner_submission: {
      submitted_at: new Date(),
      notes: adminDetails,
      receipts: []
    },
    internal_approval_request_id: approvalRequest?._id || null
  });

  res.json({
    success: true,
    data: {
      deliveryChange: dcRecord,
      approvalRequestId: approvalRequest?._id || null
    }
  });
});

export const completeProject = asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  const tenantDb = await getTenantConnection(req.orgId);
  const projectRepo = new ProjectRegisterRepository(tenantDb);
  const project = await projectRepo.findById(projectId);
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');

  if (project.delivery_status === 'delivered_and_handed_off') {
    throw new AppError('Project already delivered and handed off', 400, 'PROJECT_ALREADY_COMPLETED');
  }

  const dcRepo = new ProjectDeliveryChangeRepository(tenantDb);
  const activeDeliveryChange = await dcRepo.findActiveByProjectId(projectId);
  if (activeDeliveryChange && activeDeliveryChange.status !== 'completed') {
    throw new AppError(
      'There is an extra expense for this project that is yet to be approved',
      400,
      'PROJECT_EXTRA_EXPENSE_PENDING'
    );
  }

  const materialsFiles = Array.isArray(project?.metadata?.delivery_materials?.files)
    ? project.metadata.delivery_materials.files
    : [];
  const hasDeliveryMaterials =
    !!project?.metadata?.delivery_materials_ready || materialsFiles.length > 0;

  if (!hasDeliveryMaterials) {
    throw new AppError(
      'Upload acquittal documents before completing the project',
      400,
      'AQUITTAL_DOC_REQUIRED'
    );
  }

  const expenseRepo = new ExpenseRepository(tenantDb);
  const readiness = await expenseRepo.getProjectDeliveryReadiness(projectId);
  const paidTotal = Number(readiness?.paidAmount || 0);

  const FundingAgreement = tenantDb.model('FundingAgreement');
  const agreement = project.agreement_id ? await FundingAgreement.findById(project.agreement_id) : null;
  const completionMeta = project.metadata && typeof project.metadata === 'object' ? project.metadata : {};
  const budget = project.agreement_id
    ? Number(agreement?.total_amount || 0)
    : String(project.project_kind || '') === 'internal'
      ? Number(completionMeta.internal_budget || 0)
      : 0;
  const remaining = Math.max(0, budget - paidTotal);

  // Create delivery workflow if not already active.
  const workflowService = new ApprovalWorkflowService(req.orgId);
  let deliveryApprovalRequestId = project.metadata?.delivery_approval_request_id || null;
  if (project.delivery_status !== 'in_progress') {
    const ar = await workflowService.createProjectDeliveryCompletionRequest(
      projectId,
      req.user?.userId || req.userId
    );
    deliveryApprovalRequestId = ar?._id || null;
  }

  // Create refund entity immediately when project is completed with remaining funds.
  let refundRecord = null;
  if (remaining > 0) {
    const refundRepo = new ProjectRefundRepository(tenantDb);
    const existingRefund = await refundRepo.findActiveByProjectId(projectId);
    if (!existingRefund) {
      const orgRepo = new OrganizationRepository(tenantDb);
      const org = await orgRepo.findOne();
      const token = crypto.randomBytes(24).toString('hex');

      refundRecord = await refundRepo.create({
        org_key: req.orgId,
        org_id: org?._id,
        project_id: projectId,
        agreement_id: project.agreement_id || null,
        token,
        refund_amount: remaining,
        admin_explanation: `Remaining fund after project completion: ${remaining}`,
        status: 'pending_initiation'
      });
    } else {
      refundRecord = existingRefund;
    }
  }

  const updated = await projectRepo.update(projectId, {
    status: 'completed',
    metadata: {
      ...(project.metadata || {}),
      completed_requested_at: new Date(),
      delivery_approval_request_id: deliveryApprovalRequestId
    }
  });

  res.json({
    success: true,
    data: {
      project: updated,
      deliveryApprovalRequestId,
      remaining_amount: remaining,
      refund: refundRecord
    }
  });
});

