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

  if (req.body.category === 'fiscal_report') {
    try {
      const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
      const wf = new ApprovalWorkflowService(orgId);
      await wf.createFinancialReportingApprovalRequest(document._id, userId);
      logInfo('Fiscal report approval workflow started', { orgId, documentId: String(document._id) });
    } catch (err) {
      logError('Fiscal report uploaded but workflow could not be started', {
        orgId,
        documentId: String(document._id),
        error: err?.message
      });
    }
  }

  if (req.body.category === 'bas_lodgement') {
    try {
      const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
      const wf = new ApprovalWorkflowService(orgId);
      await wf.createBasLodgementApprovalRequest(document._id, userId);
      logInfo('BAS lodgement approval workflow started', { orgId, documentId: String(document._id) });
    } catch (err) {
      logError('BAS uploaded but workflow could not be started', {
        orgId,
        documentId: String(document._id),
        error: err?.message
      });
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

  res.status(201).json({
    success: true,
    data: documentWithUrl
  });
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

  const document = await documentRepo.update(documentId, req.body);
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

    try {
      const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
      const wf = new ApprovalWorkflowService(orgId);
      if (cat === 'fiscal_report') {
        await wf.createFinancialReportingApprovalRequest(doc._id, userId);
      } else {
        await wf.createBasLodgementApprovalRequest(doc._id, userId);
      }
    } catch (err) {
      logError('Replaced fiscal/BAS file but workflow could not be restarted', {
        orgId,
        documentId: String(documentId),
        error: err?.message
      });
    }

    const latest = await documentRepo.findById(documentId);
    const docObj = latest ? latest.toObject() : doc.toObject();
    let fileUrl = url;
    try {
      fileUrl = await getFileUrl(docObj.file_path);
    } catch {
      /* keep upload response url */
    }
    res.json({ success: true, data: { ...docObj, file_url: fileUrl } });
    return;
  }

  throw new AppError(
    'This document is not awaiting a replacement file. Open the related approval to see the current status.',
    400,
    'REPLACE_NOT_ALLOWED'
  );
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
