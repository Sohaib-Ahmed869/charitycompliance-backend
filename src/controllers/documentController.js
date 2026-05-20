/**
 * Document Controller
 * 
 * Handles HTTP requests for document management
 */

import mongoose from 'mongoose';
import { getTenantConnection } from '../db/connectionManager.js';
import { DocumentRepository } from '../repositories/documentRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToS3, deleteFromS3, getFileUrl } from '../services/s3Service.js';
import { logError, logInfo } from '../utils/logger.js';
import { buildBasPeriodMetadata } from '../services/basPeriodDocumentHelper.js';

const safeParseMetadata = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      let parsed = JSON.parse(raw);
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

function lastDayOfMonthUtc(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0, 23, 59, 59, 999));
}

/**
 * Normalise fiscal report metadata and compute period_key + due_date (UTC).
 * document_type: fiscal_report_monthly | fiscal_report_yearly
 */
function buildFiscalReportMetadata(rawMeta, documentType) {
  const base = typeof rawMeta === 'object' && rawMeta ? { ...rawMeta } : {};
  const dt = String(documentType || '').trim();
  if (dt === 'fiscal_report_monthly') {
    const y = Number(base.period_year);
    const m = Number(base.period_month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      throw new AppError('For monthly fiscal reports, metadata.period_year and metadata.period_month (1–12) are required.', 400, 'INVALID_FISCAL_PERIOD');
    }
    base.report_schedule = 'monthly';
    base.period_year = y;
    base.period_month = m;
    base.period_key = `${y}-${String(m).padStart(2, '0')}`;
    base.due_date = lastDayOfMonthUtc(y, m);
    return base;
  }
  if (dt === 'fiscal_report_yearly') {
    const endY = Number(base.financial_year_end_year);
    if (!Number.isFinite(endY)) {
      throw new AppError('For yearly fiscal reports, metadata.financial_year_end_year is required (June 30 of that year, Australian FY).', 400, 'INVALID_FISCAL_PERIOD');
    }
    base.report_schedule = 'yearly';
    base.financial_year_end_year = endY;
    base.period_key = `FY-${endY}`;
    base.due_date = new Date(Date.UTC(endY, 5, 30, 23, 59, 59, 999));
    if (!base.financial_year_label) {
      base.financial_year_label = `FY${endY - 1}–${String(endY).slice(-2)}`;
    }
    return base;
  }
  throw new AppError('Fiscal reports must use document_type fiscal_report_monthly or fiscal_report_yearly.', 400, 'INVALID_FISCAL_TYPE');
}

export const getDocuments = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const category = req.query.category || null;
  const documents = await documentRepo.findByOrgId(org._id, category);

  // Generate presigned URLs for all documents
  const documentsWithUrls = await Promise.all(
    documents.map(async (doc) => {
      try {
        const fileUrl = await getFileUrl(doc.file_path);
        return {
          ...doc.toObject(),
          file_url: fileUrl
        };
      } catch (error) {
        // If URL generation fails, return document without URL
        return {
          ...doc.toObject(),
          file_url: null
        };
      }
    })
  );

  res.json({
    success: true,
    data: documentsWithUrls
  });
});

export const getDocumentById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { documentId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);

  const document = await documentRepo.findById(documentId);
  if (!document) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  // Generate presigned URL for file access
  const fileUrl = await getFileUrl(document.file_path);

  const documentWithUrl = {
    ...document.toObject(),
    file_url: fileUrl
  };

  res.json({
    success: true,
    data: documentWithUrl
  });
});

export const createDocument = asyncHandler(async (req, res) => {
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

  // Check if file was uploaded
  if (!req.file) {
    throw new AppError('File is required', 400, 'FILE_REQUIRED');
  }

  const orgId = req.orgId;
  const userIdString = req.user?.userId || req.user?._id;
  
  if (!userIdString) {
    throw new AppError('User ID not found in request', 401, 'USER_ID_MISSING');
  }
  
  // Convert userId string to ObjectId
  let userId;
  try {
    userId = new mongoose.Types.ObjectId(userIdString);
  } catch (error) {
    throw new AppError('Invalid user ID format', 400, 'INVALID_USER_ID');
  }
  
  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  let fiscalMetadata = null;
  if (req.body.category === 'fiscal_report') {
    fiscalMetadata = buildFiscalReportMetadata(safeParseMetadata(req.body.metadata), req.body.document_type);
    const blocking = await documentRepo.findBlockingFiscalReport(org._id, fiscalMetadata.period_key);
    if (blocking) {
      throw new AppError(
        'A fiscal report for this period is already submitted or awaiting approval.',
        409,
        'FISCAL_REPORT_DUPLICATE'
      );
    }
  }

  let basMetadata = null;
  if (req.body.category === 'bas_lodgement') {
    if (String(req.body.document_type || '').trim() !== 'bas_period_quarterly') {
      throw new AppError('BAS lodgement documents must use document_type bas_period_quarterly.', 400, 'INVALID_BAS_DOC_TYPE');
    }
    basMetadata = buildBasPeriodMetadata(safeParseMetadata(req.body.metadata));
    basMetadata.bas_stage = 'submitted';
    const existingBas = await documentRepo.findBasPeriodByKey(org._id, basMetadata.period_key);
    if (existingBas) {
      throw new AppError(
        'A BAS period document for this quarter already exists. Open Finance → BAS lodgement and use the existing period, or remove the duplicate first.',
        409,
        'BAS_PERIOD_DUPLICATE'
      );
    }
  }

  // Upload file to S3
  const { key, url } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    req.body.category || 'other'
  );

  let relatedBoardMemberId;
  if (req.body.related_board_member_id) {
    try {
      relatedBoardMemberId = new mongoose.Types.ObjectId(String(req.body.related_board_member_id));
    } catch {
      relatedBoardMemberId = undefined;
    }
  }

  // Create document record
  const document = await documentRepo.create({
    org_id: org._id,
    uploaded_by: userId,
    category: req.body.category,
    document_type: req.body.document_type,
    registration_number: req.body.registration_number,
    licence_type: req.body.licence_type,
    issuing_authority: req.body.issuing_authority,
    renewal_requirements: req.body.renewal_requirements,
    state_or_territory: req.body.state_or_territory,
    related_board_member_id: relatedBoardMemberId,
    title: req.body.title,
    description: req.body.description,
    file_name: req.file.originalname,
    file_path: key, // Store S3 key instead of path
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    date_adopted: req.body.date_adopted ? new Date(req.body.date_adopted) : undefined,
    date_last_amended: req.body.date_last_amended ? new Date(req.body.date_last_amended) : undefined,
    effective_date: req.body.effective_date ? new Date(req.body.effective_date) : undefined,
    review_date: req.body.review_date ? new Date(req.body.review_date) : undefined,
    expiry_date: req.body.expiry_date ? new Date(req.body.expiry_date) : undefined
    ,
    status:
      req.body.category === 'fiscal_report'
        ? 'submitted'
        : req.body.category === 'bas_lodgement'
          ? 'submitted'
          : (req.body.status || 'submitted'),
    metadata: fiscalMetadata || basMetadata || safeParseMetadata(req.body.metadata)
  });

  // Fiscal reports and BAS lodgements auto-start an approval workflow on upload.
  // We catch failures so the upload itself isn't rolled back, but we surface the
  // outcome on the response so the FE can tell the user what actually happened
  // (and pop the WORKFLOW_NOT_CONFIGURED guard dialog if the workflow is missing).
  let workflowOutcome = null;
  if (req.body.category === 'fiscal_report' || req.body.category === 'bas_lodgement') {
    const isFiscal = req.body.category === 'fiscal_report';
    try {
      const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
      const wf = new ApprovalWorkflowService(orgId);
      const approvalRequest = isFiscal
        ? await wf.createFinancialReportingApprovalRequest(document._id, userId)
        : await wf.createBasLodgementApprovalRequest(document._id, userId);
      workflowOutcome = { started: true, approvalRequestId: String(approvalRequest._id) };
      logInfo(`${isFiscal ? 'Fiscal report' : 'BAS lodgement'} approval workflow started`, {
        orgId, documentId: String(document._id), approvalRequestId: String(approvalRequest._id)
      });
    } catch (err) {
      logError(`${isFiscal ? 'Fiscal report' : 'BAS'} uploaded but workflow could not be started`, {
        orgId,
        documentId: String(document._id),
        error: err?.message,
        code: err?.code
      });
      workflowOutcome = {
        started: false,
        code: err?.code || 'WORKFLOW_START_FAILED',
        message: err?.message || 'Approval workflow could not be started.',
        details: err?.details || null
      };
    }
  }

  // Update progress if this is a governing document
  if (req.body.category === 'governing_document' || req.body.category === 'constitution') {
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    await progressRepo.updateProfileStep(org._id, 'documents_complete', true);
  }

  // Return document with presigned URL
  const latest = await documentRepo.findById(document._id);
  const docObj = latest ? latest.toObject() : document.toObject();
  const documentWithUrl = {
    ...docObj,
    file_url: url
  };

  const responseBody = { success: true, data: documentWithUrl };
  if (workflowOutcome) responseBody.workflow = workflowOutcome;
  res.status(201).json(responseBody);
});

export const updateDocument = asyncHandler(async (req, res) => {
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
  const { documentId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);

  const existing = await documentRepo.findById(documentId);
  if (!existing) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  // Build the update payload field-by-field. We only forward fields
  // the caller actually sent (so an unrelated PUT can't accidentally
  // clear stored data), and coerce date-strings to Date objects since
  // the schema's setter doesn't run on $set with raw strings.
  const body = req.body || {};
  const update = {};
  const stringFields = [
    'document_type', 'registration_number', 'title', 'description',
    'category', 'related_board_member_id', 'renewal_requirements',
    'state_or_territory'
  ];
  for (const f of stringFields) {
    if (Object.prototype.hasOwnProperty.call(body, f) && body[f] !== '') {
      update[f] = body[f];
    }
  }
  const dateFields = [
    'date_adopted', 'date_last_amended', 'effective_date',
    'review_date', 'expiry_date'
  ];
  for (const f of dateFields) {
    if (Object.prototype.hasOwnProperty.call(body, f) && body[f]) {
      const d = new Date(body[f]);
      if (!Number.isNaN(d.getTime())) update[f] = d;
    }
  }

  // Optional file replacement. When the caller posted multipart/form-data
  // with a new `file`, swap it on S3 + update the snapshot fields.
  // The old S3 object is left in place if the new upload succeeds AND
  // delete fails — better to have an orphan than to break the record.
  if (req.file) {
    const subfolder = update.category || existing.category || 'document';
    const uploaded = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      orgId,
      subfolder
    );
    update.file_name = req.file.originalname;
    update.file_path = uploaded.key;
    update.file_size = req.file.size;
    update.mime_type = req.file.mimetype;
    if (existing.file_path && existing.file_path !== uploaded.key) {
      try { await deleteFromS3(existing.file_path); }
      catch (err) { console.warn('[updateDocument] old S3 file delete failed:', err?.message || err); }
    }
  }

  // Version-number bump.
  //   File replaced via this endpoint  → major +1, minor → 0
  //   Metadata-only edit               → minor +1 (when at least one
  //                                      tracked field actually changed)
  const trackedMetadataFields = [
    'document_type', 'registration_number', 'title', 'description',
    'date_adopted', 'date_last_amended', 'effective_date',
    'review_date', 'expiry_date'
  ];
  const metadataChanged = trackedMetadataFields.some((f) => {
    if (!Object.prototype.hasOwnProperty.call(update, f)) return false;
    const before = existing[f];
    const after = update[f];
    if (before instanceof Date || after instanceof Date) {
      const a = before ? new Date(before).getTime() : null;
      const b = after ? new Date(after).getTime() : null;
      return a !== b;
    }
    return (before ?? '') !== (after ?? '');
  });
  if (req.file) {
    update.version = (existing.version || 1) + 1;
    update.minor_version = 0;
  } else if (metadataChanged) {
    update.version = existing.version || 1;
    update.minor_version = (existing.minor_version || 0) + 1;
  }

  const document = await documentRepo.update(documentId, update);
  if (!document) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  res.json({
    success: true,
    data: document
  });
});

export const reviewYearlyStatement = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { documentId } = req.params;
  const userIdString = req.user?.userId || req.user?._id;
  const signature = String(req.body?.signature || '').trim();

  if (!signature) {
    throw new AppError('Signature is required', 400, 'SIGNATURE_REQUIRED');
  }

  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const doc = await documentRepo.findById(documentId);
  if (!doc) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }
  if (doc.category !== 'financial_statement') {
    throw new AppError('Only yearly statements can be reviewed here', 400, 'INVALID_CATEGORY');
  }

  const assignedBoardMemberId = doc?.metadata?.reviewer_board_member_id;
  if (!assignedBoardMemberId) {
    throw new AppError('No board reviewer is assigned for this statement', 400, 'REVIEWER_NOT_ASSIGNED');
  }

  const boardMember = await boardMemberRepo.findByUserId(userIdString, doc.org_id);
  if (!boardMember || String(boardMember._id) !== String(assignedBoardMemberId)) {
    throw new AppError('Only the assigned board member can review and sign this statement', 403, 'NOT_ASSIGNED_REVIEWER');
  }

  const now = new Date();
  const reviewerName = [boardMember.given_names, boardMember.family_name].filter(Boolean).join(' ').trim();
  const mergedMetadata = {
    ...(doc.metadata || {}),
    review_status: 'reviewed',
    reviewed_at: now.toISOString(),
    reviewed_by_board_member_id: String(boardMember._id),
    reviewed_by_user_id: userIdString ? String(userIdString) : null,
    reviewed_by_name: reviewerName || 'Board Member',
    review_signature: signature
  };

  const updated = await documentRepo.update(documentId, {
    status: 'reviewed',
    metadata: mergedMetadata
  });

  res.json({
    success: true,
    data: updated
  });
});

/**
 * Replace file for a fiscal report or BAS document when resubmission is required,
 * or when the approval is returned_for_resubmission (replace file, then submitter resubmits workflow).
 */
export const replaceWorkflowDocumentFile = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  if (!req.file) {
    throw new AppError('File is required', 400, 'FILE_REQUIRED');
  }

  const orgId = req.orgId;
  const { documentId } = req.params;
  const userIdString = req.user?.userId || req.user?._id;
  if (!userIdString) {
    throw new AppError('User ID not found in request', 401, 'USER_ID_MISSING');
  }
  let userId;
  try {
    userId = new mongoose.Types.ObjectId(userIdString);
  } catch {
    throw new AppError('Invalid user ID format', 400, 'INVALID_USER_ID');
  }

  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);
  const { ApprovalRequestRepository } = await import('../repositories/approvalRequestRepository.js');
  const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const doc = await documentRepo.findById(documentId);
  if (!doc || String(doc.org_id) !== String(org._id)) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  const cat = String(doc.category);
  if (!['fiscal_report', 'bas_lodgement'].includes(cat)) {
    throw new AppError('This upload is only for fiscal reports or BAS lodgement documents.', 400, 'INVALID_CATEGORY');
  }

  let approval = null;
  const arId = doc.metadata?.approval_request_id;
  if (arId) {
    approval = await approvalRequestRepo.findById(arId);
  }

  const oldKey = doc.file_path;
  const { key, url } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    cat
  );
  const nextVersion = (doc.version || 1) + 1;
  const baseFileUpdate = {
    file_name: req.file.originalname,
    file_path: key,
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    version: nextVersion
  };

  const tryDeleteOld = async () => {
    if (!oldKey || oldKey === key) return;
    try {
      await deleteFromS3(oldKey);
    } catch (e) {
      logError('replaceWorkflowDocumentFile: failed to delete previous S3 object', { error: e?.message, oldKey });
    }
  };

  if (approval?.status === 'returned_for_resubmission') {
    await tryDeleteOld();
    const prevMeta = doc.metadata && typeof doc.metadata === 'object' ? { ...doc.metadata } : {};
    prevMeta.resubmission_file_replaced_at = new Date().toISOString();
    prevMeta.workflow_last_decision = 'file_replaced_pending_resubmit';
    await documentRepo.update(documentId, {
      ...baseFileUpdate,
      status: 'resubmission_required',
      metadata: prevMeta
    });
    const latest = await documentRepo.findById(documentId);
    const docObj = latest ? latest.toObject() : doc.toObject();
    res.json({ success: true, data: { ...docObj, file_url: url } });
    return;
  }

  if (doc.status === 'resubmission_required' || approval?.status === 'rejected') {
    await tryDeleteOld();
    const prevMeta = doc.metadata && typeof doc.metadata === 'object' ? { ...doc.metadata } : {};
    prevMeta.previous_approval_request_id = prevMeta.approval_request_id || null;
    delete prevMeta.resubmission_reason;
    delete prevMeta.resubmission_requested_at;
    prevMeta.workflow_last_decision = 'pending_new_approval';
    await documentRepo.update(documentId, {
      ...baseFileUpdate,
      status: 'submitted',
      metadata: prevMeta
    });

    let workflowOutcome = null;
    try {
      const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
      const wf = new ApprovalWorkflowService(orgId);
      const approvalRequest = cat === 'fiscal_report'
        ? await wf.createFinancialReportingApprovalRequest(doc._id, userId)
        : await wf.createBasLodgementApprovalRequest(doc._id, userId);
      workflowOutcome = { started: true, approvalRequestId: String(approvalRequest._id) };
    } catch (err) {
      logError('Replaced fiscal/BAS file but workflow could not be restarted', {
        orgId,
        documentId: String(documentId),
        error: err?.message,
        code: err?.code
      });
      workflowOutcome = {
        started: false,
        code: err?.code || 'WORKFLOW_START_FAILED',
        message: err?.message || 'Approval workflow could not be started.',
        details: err?.details || null
      };
    }

    const latest = await documentRepo.findById(documentId);
    const docObj = latest ? latest.toObject() : doc.toObject();
    let fileUrl = url;
    try {
      fileUrl = await getFileUrl(docObj.file_path);
    } catch {
      /* keep upload response url */
    }
    res.json({ success: true, data: { ...docObj, file_url: fileUrl }, workflow: workflowOutcome });
    return;
  }

  throw new AppError(
    'This document is not awaiting a replacement file. Open the related approval to see the current status.',
    400,
    'REPLACE_NOT_ALLOWED'
  );
});

/**
 * GET /platform/documents/:documentId/versions
 *
 * Returns the version history for a document: the current "head"
 * row + every row whose parent_document_id points at it OR at a
 * shared parent. We also resolve the parent chain so an arbitrary
 * mid-chain document still surfaces its full history.
 */
export const getDocumentVersions = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { documentId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);

  const root = await documentRepo.findById(documentId);
  if (!root) throw new AppError('Document not found', 404, 'NOT_FOUND');

  // Walk up to the original parent (if any).
  let head = root;
  while (head.parent_document_id) {
    // eslint-disable-next-line no-await-in-loop
    const parent = await documentRepo.findById(head.parent_document_id);
    if (!parent) break;
    head = parent;
  }

  const children = await documentRepo.findVersions(head._id);
  const all = [head, ...children]
    .filter((d, idx, arr) => arr.findIndex((x) => String(x._id) === String(d._id)) === idx)
    .sort((a, b) => (b.version || 1) - (a.version || 1));

  // Attach a presigned file URL to each row so the UI can link straight
  // to the underlying S3 object without a second round-trip.
  const withUrls = await Promise.all(all.map(async (d) => {
    let file_url = null;
    try { file_url = await getFileUrl(d.file_path); } catch { /* leave null */ }
    return { ...d.toObject(), file_url };
  }));

  res.json({ success: true, data: { head_id: String(head._id), versions: withUrls } });
});

/**
 * POST /platform/documents/:documentId/versions
 *
 * Upload a new version of an existing document. The new row is
 * linked to the original via parent_document_id and gets the next
 * incremental version number. Metadata is copied from the parent
 * and selectively overridden by anything in the request body.
 */
export const uploadDocumentVersion = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { documentId } = req.params;
  if (!req.file) {
    throw new AppError('A file is required to create a new version.', 400, 'FILE_REQUIRED');
  }

  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);
  const parent = await documentRepo.findById(documentId);
  if (!parent) throw new AppError('Parent document not found', 404, 'NOT_FOUND');

  // Resolve the head of the chain so versions all hang off the same root.
  let head = parent;
  while (head.parent_document_id) {
    // eslint-disable-next-line no-await-in-loop
    const upstream = await documentRepo.findById(head.parent_document_id);
    if (!upstream) break;
    head = upstream;
  }

  const subfolder = parent.category || 'document';
  const uploaded = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    subfolder
  );

  // Build the version doc — start from the parent's metadata, then
  // overlay any fields the caller supplied (title / dates / type).
  const body = req.body || {};
  const data = {
    org_id: head.org_id,
    category: head.category,
    document_type: body.document_type || parent.document_type,
    registration_number: body.registration_number ?? parent.registration_number,
    title: body.title || parent.title,
    description: body.description ?? parent.description,
    file_name: req.file.originalname,
    file_path: uploaded.key,
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    // New file → major bump (createVersion does parent.version + 1) +
    // minor reset to 0. Explicit so we don't inherit whatever minor
    // the parent currently sits at.
    minor_version: 0,
    date_adopted: body.date_adopted ? new Date(body.date_adopted) : parent.date_adopted,
    date_last_amended: body.date_last_amended ? new Date(body.date_last_amended) : new Date(),
    effective_date: body.effective_date ? new Date(body.effective_date) : parent.effective_date,
    review_date: body.review_date ? new Date(body.review_date) : parent.review_date,
    expiry_date: body.expiry_date ? new Date(body.expiry_date) : parent.expiry_date,
    uploaded_by: req.user?.userId || null
  };

  const created = await documentRepo.createVersion(head._id, data);
  let file_url = null;
  try { file_url = await getFileUrl(created.file_path); } catch { /* leave null */ }

  res.status(201).json({
    success: true,
    data: { ...created.toObject(), file_url }
  });
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { documentId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const documentRepo = new DocumentRepository(tenantDb);

  // Get document to retrieve S3 key before deleting
  const document = await documentRepo.findById(documentId);
  if (!document) {
    throw new AppError('Document not found', 404, 'NOT_FOUND');
  }

  // Delete from S3
  try {
    await deleteFromS3(document.file_path);
  } catch (error) {
    // Log error but continue with database deletion
    console.error('Error deleting file from S3:', error);
  }

  // Delete from database
  await documentRepo.delete(documentId);

  res.json({
    success: true,
    message: 'Document deleted successfully'
  });
});
