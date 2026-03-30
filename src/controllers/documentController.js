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

  // Upload file to S3
  const { key, url } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    req.body.category || 'other'
  );

  // Create document record
  const document = await documentRepo.create({
    org_id: org._id,
    uploaded_by: userId,
    category: req.body.category,
    document_type: req.body.document_type,
    registration_number: req.body.registration_number,
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
    status: req.body.status || 'submitted',
    metadata: safeParseMetadata(req.body.metadata)
  });

  // Update progress if this is a governing document
  if (req.body.category === 'governing_document' || req.body.category === 'constitution') {
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    await progressRepo.updateProfileStep(org._id, 'documents_complete', true);
  }

  // Return document with presigned URL
  const documentWithUrl = {
    ...document.toObject(),
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
