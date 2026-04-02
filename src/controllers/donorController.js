/**
 * Donor Controller
 *
 * HTTP handlers for donor register.
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { DonorService } from '../services/donorService.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { DonorRepository } from '../repositories/donorRepository.js';
import { DonorRefundRepository } from '../repositories/donorRefundRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import emailService from '../services/emailService.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import crypto from 'crypto';
import { logWarn } from '../utils/logger.js';

const parsePublicToken = (token, req) => {
  // Expected: "<orgKey>.<token>"
  const raw = String(token || '').trim();
  const dotIdx = raw.indexOf('.');
  const prefix = dotIdx >= 0 ? raw.slice(0, dotIdx) : '';
  const rest = dotIdx >= 0 ? raw.slice(dotIdx + 1) : '';
  const orgKey = prefix || req?.headers?.['x-org-id'] || null;
  if (!orgKey || !rest) return null;
  return { orgKey, token: rest };
};

/** RFC 2397 data URL → binary + mime (for evidence uploads). */
function parseDataUrlPayload(dataUrl) {
  const s = String(dataUrl).trim();
  const m = s.match(/^data:([^,]*?)(;base64)?,(.*)$/s);
  if (!m) return null;
  const header = m[1] || '';
  const isBase64 = m[2] === ';base64';
  const payload = m[3] ?? '';
  const mimeType = header.split(';')[0].trim() || 'application/octet-stream';
  try {
    const buffer = isBase64
      ? Buffer.from(String(payload).replace(/\s/g, ''), 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (!buffer.length) return null;
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_INLINE_ATTACHMENTS = 12 * 1024 * 1024;

/**
 * Store data-URL attachments in S3 when possible so MongoDB stays under the ~16MB BSON document limit.
 * Falls back to inline data_url only for small files when S3 is unavailable.
 */
async function persistDataUrlAttachments(items, orgId, s3Category) {
  const { uploadToS3 } = await import('../services/s3Service.js');
  const out = [];
  let inlineTotal = 0;
  for (let i = 0; i < items.length; i++) {
    const file_name = String(items[i]?.file_name || '').trim();
    const data_url = String(items[i]?.data_url || '').trim();
    if (!data_url) {
      if (file_name) out.push({ file_name, data_url: '', url: '', key: '' });
      continue;
    }
    const parsed = parseDataUrlPayload(data_url);
    if (!parsed) {
      throw new AppError(
        `Attachment "${file_name || `file ${i + 1}`}" is not a valid data URL.`,
        400,
        'INVALID_ATTACHMENT'
      );
    }
    try {
      const uploaded = await uploadToS3(
        parsed.buffer,
        file_name || `attachment-${i + 1}`,
        parsed.mimeType,
        String(orgId),
        s3Category
      );
      out.push({
        file_name: file_name || `file-${i + 1}`,
        url: uploaded.url,
        key: uploaded.key,
        data_url: ''
      });
    } catch (uploadErr) {
      logWarn('S3 upload failed; attempting inline donor refund attachment', {
        category: s3Category,
        message: uploadErr?.message
      });
      if (parsed.buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
        throw new AppError(
          'Files are too large to store without cloud file storage. Please use smaller PDFs or images, or contact the charity.',
          413,
          'ATTACHMENT_TOO_LARGE'
        );
      }
      if (inlineTotal + parsed.buffer.length > MAX_TOTAL_INLINE_ATTACHMENTS) {
        throw new AppError(
          'Total attachment size is too large. Please submit fewer or smaller files.',
          413,
          'ATTACHMENTS_TOO_LARGE'
        );
      }
      inlineTotal += parsed.buffer.length;
      out.push({ file_name: file_name || `file-${i + 1}`, data_url });
    }
  }
  return out;
}

export const createDonor = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const donor = await service.createDonor(req.body, userId);

  res.status(201).json({
    success: true,
    data: donor
  });
});

export const listDonors = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const filters = {
    status: req.query.status,
    search: req.query.search
  };

  const donors = await service.listDonors(filters);

  res.json({
    success: true,
    data: donors
  });
});

export const getDonorById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const donor = await service.getDonorById(req.params.donorId);

  res.json({
    success: true,
    data: donor
  });
});

export const updateDonor = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const donor = await service.updateDonor(req.params.donorId, req.body);

  res.json({
    success: true,
    data: donor
  });
});

/**
 * Upload donor KYC documents to S3 and return file metadata.
 * Mirrors approval acknowledgement upload but uses a dedicated "donor_kyc" category.
 */
export const uploadDonorKycDocuments = asyncHandler(async (req, res) => {
  const files = req.files;
  const orgId = req.body.org_id || req.orgId;

  if (!files || files.length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'NO_FILES', message: 'No files uploaded' }
    });
  }

  const { uploadToS3 } = await import('../services/s3Service.js');

  const uploadedFiles = [];

  for (const file of files) {
    const result = await uploadToS3(
      file.buffer,
      file.originalname,
      file.mimetype,
      orgId,
      'donor_kyc'
    );

    uploadedFiles.push({
      name: file.originalname,
      size: file.size,
      file_type: file.mimetype,
      url: result.url,
      key: result.key
    });
  }

  res.json({
    success: true,
    files: uploadedFiles
  });
});

export const initiateDonorRefund = asyncHandler(async (req, res) => {
  const orgKey = req.orgId;
  const { donorId } = req.params;
  const userId = req.user?.userId || req.userId || req.user?._id || null;
  const adminNotes = String(req.body?.admin_notes || '').trim();

  const tenantDb = await getTenantConnection(orgKey);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const donorRepo = new DonorRepository(tenantDb);
  const donor = await donorRepo.findById(donorId);
  if (!donor) throw new AppError('Donor not found', 404, 'DONOR_NOT_FOUND');

  const donorEmail = String(donor?.primary_contact?.email || donor?.email || '').trim().toLowerCase();
  if (!donorEmail) throw new AppError('Donor email is required to initiate refund', 400, 'DONOR_EMAIL_REQUIRED');

  const refundRepo = new DonorRefundRepository(tenantDb);
  const existingActive = await refundRepo.findActiveByDonorId(donorId);
  if (existingActive) {
    throw new AppError('A refund process is already active for this donor', 409, 'REFUND_ALREADY_ACTIVE');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const created = await refundRepo.create({
    org_key: String(orgKey),
    org_id: String(org._id),
    donor_id: donor._id,
    token,
    status: 'awaiting_donor_form',
    initiated_at: new Date(),
    initiated_by: userId || null,
    donor_contact_email: donorEmail,
    admin_notes: adminNotes || '',
  });

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const formLink = `${baseUrl}/public/donors/refunds/${orgKey}.${token}`;

  await emailService.sendDonorRefundExternalFormEmail({
    to: donorEmail,
    recipientName: donor?.primary_contact?.name || donor?.name || 'Donor',
    donorName: donor?.name || 'Donor',
    formLink,
  });

  res.json({ success: true, data: created });
});

export const listDonorRefunds = asyncHandler(async (req, res) => {
  const orgKey = req.orgId;
  const donorId = req.query?.donorId || null;
  const tenantDb = await getTenantConnection(orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const rows = await repo.findByOrgKey(orgKey, donorId || null);
  res.json({ success: true, data: rows || [] });
});

export const submitDonorRefundPublicForm = asyncHandler(async (req, res) => {
  const parsed = parsePublicToken(req.params.token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const record = await repo.findByToken(parsed.token, parsed.orgKey);
  if (!record) throw new AppError('Refund link not found', 404, 'NOT_FOUND');

  const st = String(record.status || '');
  if (!['awaiting_donor_form', 'pending_initiation'].includes(st)) {
    throw new AppError('This refund form is no longer active', 400, 'REFUND_NOT_ACTIVE');
  }

  const evidence = Array.isArray(req.body?.evidence) ? req.body.evidence : [];
  const evidenceRaw = evidence
    .map((e) => ({
      file_name: String(e?.file_name || e?.fileName || e?.name || '').trim(),
      data_url: String(e?.data_url || e?.dataUrl || e?.data || '').trim(),
    }))
    .filter((e) => e.file_name || e.data_url);

  const persistedEvidence = await persistDataUrlAttachments(
    evidenceRaw,
    record.org_id,
    'donor-refund-evidence'
  );

  const updated = await repo.updateById(record._id, {
    status: 'donor_form_submitted',
    donor_submission: {
      submitted_at: new Date(),
      donation_date: String(req.body?.donation_date || '').trim(),
      donation_amount: Number(req.body?.donation_amount || 0),
      payment_method: String(req.body?.payment_method || '').trim(),
      reason: String(req.body?.reason || '').trim(),
      notes: String(req.body?.notes || '').trim(),
      evidence: persistedEvidence,
    },
  });

  res.json({ success: true, data: updated });
});

export const initiateDonorRefundWorkflow = asyncHandler(async (req, res) => {
  const orgKey = req.orgId;
  const { refundId } = req.params;
  const userId = req.user?._id || req.userId || null;

  const service = new ApprovalWorkflowService(orgKey);
  const created = await service.createDonorRefundApprovalRequest(refundId, userId);

  res.json({ success: true, data: created });
});

export const startDonorRefundProcessing = asyncHandler(async (req, res) => {
  const orgKey = req.orgId;
  const { refundId } = req.params;
  const tenantDb = await getTenantConnection(orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const record = await repo.findById(refundId);
  if (!record) throw new AppError('Refund record not found', 404, 'NOT_FOUND');

  const st = String(record.status || '');
  if (record.internal_approval_request_id && st !== 'internal_approved') {
    throw new AppError('Refund must be internally approved before processing', 400, 'REFUND_NOT_APPROVED');
  }

  if (st !== 'donor_form_submitted' && st !== 'internal_approved') {
    throw new AppError('Refund is not ready to start processing', 400, 'INVALID_STATUS');
  }

  const updated = await repo.updateById(refundId, {
    status: 'refund_processing',
    processing_started_at: new Date(),
    processing_notes: String(req.body?.processing_notes || '').trim(),
    expected_payment_date: String(req.body?.expected_payment_date || '').trim(),
  });

  res.json({ success: true, data: updated });
});

export const recordDonorRefundPaymentSent = asyncHandler(async (req, res) => {
  const orgKey = req.orgId;
  const { refundId } = req.params;
  const tenantDb = await getTenantConnection(orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const record = await repo.findById(refundId);
  if (!record) throw new AppError('Refund record not found', 404, 'NOT_FOUND');

  const st = String(record.status || '');
  if (st !== 'refund_processing') throw new AppError('Refund is not in processing state', 400, 'INVALID_STATUS');

  const paymentProof = Array.isArray(req.body?.payment_proof) ? req.body.payment_proof : [];
  const paymentProofRaw = paymentProof
    .map((p) => ({
      file_name: String(p?.file_name || p?.fileName || p?.name || '').trim(),
      data_url: String(p?.data_url || p?.dataUrl || p?.data || '').trim(),
    }))
    .filter((p) => p.file_name || p.data_url);

  const persistedProof = await persistDataUrlAttachments(
    paymentProofRaw,
    record.org_id,
    'donor-refund-payment-proof'
  );

  const ackToken = crypto.randomBytes(24).toString('hex');
  const updated = await repo.updateById(refundId, {
    status: 'awaiting_donor_acknowledgment',
    refund_payment_sent_at: new Date(),
    payment_reference: String(req.body?.payment_reference || '').trim(),
    payment_proof: persistedProof,
    payment_notification: {
      message_for_donor: String(req.body?.message_for_donor || '').trim(),
      amount_paid: Number(req.body?.amount_paid || 0),
      payment_method_used: String(req.body?.payment_method_used || '').trim(),
      sent_at: new Date(),
    },
    payment_ack_token: ackToken,
  });

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const ackLink = `${baseUrl}/public/donors/refunds/payment-ack/${orgKey}.${ackToken}`;
  const donorEmail = String(updated?.donor_contact_email || '').trim();
  if (donorEmail) {
    await emailService.sendDonorRefundPaymentAckEmail({
      to: donorEmail,
      recipientName: updated?.donor_id?.name || 'Donor',
      donorName: updated?.donor_id?.name || 'Donor',
      ackLink,
    });
  }

  res.json({ success: true, data: updated });
});

export const completeDonorRefundProcessing = asyncHandler(async (req, res) => {
  const orgKey = req.orgId;
  const { refundId } = req.params;
  const tenantDb = await getTenantConnection(orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const record = await repo.findById(refundId);
  if (!record) throw new AppError('Refund record not found', 404, 'NOT_FOUND');

  const st = String(record.status || '');
  if (!['donor_acknowledged', 'refund_payment_sent'].includes(st)) {
    throw new AppError('Refund cannot be completed yet', 400, 'INVALID_STATUS');
  }

  const updated = await repo.updateById(refundId, {
    status: 'completed',
    completion_notes: String(req.body?.completion_notes || '').trim(),
    completed_at: new Date(),
  });

  res.json({ success: true, data: updated });
});

export const getDonorRefundPaymentAckContext = asyncHandler(async (req, res) => {
  const parsed = parsePublicToken(req.params.token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const record = await repo.findByPaymentAckToken(parsed.token, parsed.orgKey);
  if (!record) throw new AppError('Invalid or expired link', 401, 'INVALID_TOKEN');

  const already = !!record?.donor_payment_acknowledgment?.submitted_at;
  res.json({
    success: true,
    data: {
      already_submitted: already,
      donor_name: record?.donor_id?.name || 'Donor',
      amount_paid: record?.payment_notification?.amount_paid || 0,
      message_for_donor: record?.payment_notification?.message_for_donor || '',
      payment_proof: record?.payment_proof || [],
    }
  });
});

export const submitDonorRefundPaymentAck = asyncHandler(async (req, res) => {
  const parsed = parsePublicToken(req.params.token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new DonorRefundRepository(tenantDb);
  const record = await repo.findByPaymentAckToken(parsed.token, parsed.orgKey);
  if (!record) throw new AppError('Invalid or expired link', 401, 'INVALID_TOKEN');

  if (record?.donor_payment_acknowledgment?.submitted_at) {
    return res.json({ success: true, data: { already_submitted: true } });
  }

  const updated = await repo.updateById(record._id, {
    status: 'donor_acknowledged',
    donor_payment_acknowledgment: {
      submitted_at: new Date(),
      signer_name: String(req.body?.signer_name || '').trim(),
      confirm_received: !!req.body?.confirm_received,
      notes: String(req.body?.notes || '').trim(),
    }
  });

  res.json({ success: true, data: updated });
});

