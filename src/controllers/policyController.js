/**
 * Policy Controller
 */

import mongoose from 'mongoose';
import { getTenantConnection } from '../db/connectionManager.js';
import { PolicyRepository, incrementVersion } from '../repositories/policyRepository.js';
import { PolicyAcknowledgementRepository } from '../repositories/policyAcknowledgementRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { uploadToS3, deleteFromS3, getFileUrl, getFileStream } from '../services/s3Service.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import { generatePolicySignOffPDF } from '../services/policySignOffPdfService.js';
import { decrypt, isEncrypted } from '../utils/encryption.js';
import { getMasterKeyHex } from '../config/encryption.js';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';

export const getPolicies = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const policyRepo = new PolicyRepository(tenantDb);
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const filters = {
    status: req.query.status || undefined,
    category: req.query.category || undefined,
    search: req.query.search || undefined
  };
  const policies = await policyRepo.findByOrgId(org._id, filters);
  const totalAudience = await boardMemberRepo.countByOrgId(org._id);

  const policiesWithUrls = await Promise.all(
    policies.map(async (p) => {
      let file_url = null;
      if (p.file_path) {
        try {
          file_url = await getFileUrl(p.file_path);
        } catch {
          // ignore
        }
      }

      let acknowledgedCount = 0;
      try {
        acknowledgedCount = await acknowledgementRepo.countByPolicyId(p._id);
      } catch {
        // ignore acknowledgement errors so policies list still loads
      }

      return {
        ...p,
        file_url,
        acknowledgement_summary: {
          acknowledged: acknowledgedCount,
          total: totalAudience
        }
      };
    })
  );

  res.json({
    success: true,
    data: policiesWithUrls
  });
});

export const getPolicyCounts = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const policyRepo = new PolicyRepository(tenantDb);
  const counts = await policyRepo.getCounts(org._id);
  res.json({
    success: true,
    data: counts
  });
});

/**
 * Policy acknowledgement stats for org dashboard widgets.
 * Counts people who have acknowledged all active policies vs pending.
 *
 * Audience is active board members in the org (including volunteers). If a person has no linked user_id,
 * they are counted as pending (they cannot acknowledge in-app).
 *
 * GET /platform/policies/acknowledgement-stats
 */
export const getPolicyAcknowledgementStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);

  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const activePolicies = await policyRepo.findByOrgId(org._id, { status: 'active' });
  const policyIds = (activePolicies || []).map((p) => p?._id).filter(Boolean);

  const boardMembers = await boardMemberRepo.findByOrgId(org._id, false);
  const audience = (boardMembers || []).filter((bm) => {
    if (bm?.is_active === false) return false;
    if (bm?.status && bm.status !== 'active') return false;
    return true;
  });

  const totalPeople = audience.length;
  if (totalPeople === 0) {
    return res.json({
      success: true,
      data: {
        totalPeople: 0,
        acknowledged: 0,
        pending: 0,
        activePolicies: policyIds.length
      }
    });
  }

  // If no active policies, consider everyone "acknowledged".
  if (policyIds.length === 0) {
    return res.json({
      success: true,
      data: {
        totalPeople,
        acknowledged: totalPeople,
        pending: 0,
        activePolicies: 0
      }
    });
  }

  // Build a fast lookup: userId -> Set(policyId) acknowledged
  const PolicyAcknowledgement =
    tenantDb.models.PolicyAcknowledgement ||
    tenantDb.model('PolicyAcknowledgement', (await import('../db/schemas/platform/policyAcknowledgementSchema.js')).default);

  const ackRows = await PolicyAcknowledgement.find({ policy_id: { $in: policyIds } }, { policy_id: 1, user_id: 1 })
    .lean();

  const userToPolicies = new Map();
  for (const row of ackRows || []) {
    const uid = row?.user_id?.toString?.();
    const pid = row?.policy_id?.toString?.();
    if (!uid || !pid) continue;
    if (!userToPolicies.has(uid)) userToPolicies.set(uid, new Set());
    userToPolicies.get(uid).add(pid);
  }

  let acknowledged = 0;
  for (const bm of audience) {
    const uid = bm?.user_id?.toString?.();
    if (!uid) continue; // no user -> cannot acknowledge in-app -> pending
    const set = userToPolicies.get(uid);
    if (set && set.size >= policyIds.length) acknowledged += 1;
  }

  const pending = Math.max(totalPeople - acknowledged, 0);

  res.json({
    success: true,
    data: {
      totalPeople,
      acknowledged,
      pending,
      activePolicies: policyIds.length
    }
  });
});

export const getPolicyDocumentLogs = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }
  const logs = await policyRepo.getDocumentLogs(policyId);
  res.json({
    success: true,
    data: logs
  });
});

export const getPolicyById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);

  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  let file_url = null;
  if (policy.file_path) {
    try {
      file_url = await getFileUrl(policy.file_path);
    } catch {
      // ignore
    }
  }

  res.json({
    success: true,
    data: { ...policy.toObject(), file_url }
  });
});

export const getPolicyForCurrentUser = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const userIdString = req.user?.userId || req.user?._id;

  if (!userIdString) {
    throw new AppError('User ID not found in request', 401, 'USER_ID_MISSING');
  }

  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);

  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  let file_url = null;
  if (policy.file_path) {
    try {
      file_url = await getFileUrl(policy.file_path);
    } catch {
      // ignore
    }
  }

  let userId;
  try {
    userId = new mongoose.Types.ObjectId(userIdString);
  } catch {
    throw new AppError('Invalid user ID format', 400, 'INVALID_USER_ID');
  }

  const acknowledgement = await acknowledgementRepo.findOneByPolicyAndUser(policyId, userId);

  res.json({
    success: true,
    data: {
      ...policy.toObject(),
      file_url,
      acknowledgement: acknowledgement || null
    }
  });
});

export const createPolicy = asyncHandler(async (req, res) => {
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

  if (!req.file) {
    throw new AppError('Policy document is required', 400, 'FILE_REQUIRED');
  }

  const orgId = req.orgId;
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
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const { key, url } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'policy'
  );

  const department_id = req.body.department_id || null;
  let departmentName = req.body.department || null;
  if (department_id && !departmentName) {
    const { DepartmentRepository } = await import('../repositories/departmentRepository.js');
    const departmentRepo = new DepartmentRepository(tenantDb);
    const dept = await departmentRepo.findById(department_id);
    if (dept) departmentName = dept.name;
  }

  const policyRepo = new PolicyRepository(tenantDb);
  const version = req.body.version || 'v1.0';
  const policy = await policyRepo.create({
    org_id: org._id,
    title: req.body.title,
    category: req.body.category,
    description: req.body.description || undefined,
    policy_owner_id: department_id ? null : (req.body.policy_owner_id || undefined),
    department_id,
    department: departmentName,
    effective_date: req.body.effective_date ? new Date(req.body.effective_date) : undefined,
    review_cycle: req.body.review_cycle || '12 months',
    review_date: req.body.review_date ? new Date(req.body.review_date) : undefined,
    file_name: req.file.originalname,
    file_path: key,
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    version,
    status: 'under_review',
    uploaded_by: userId
  });

  try {
    const workflowService = new ApprovalWorkflowService(orgId);
    await workflowService.createPolicyApprovalRequest(policy._id, userId);
  } catch (err) {
    const errCode = err?.code;
    const isNoWorkflow =
      err?.name === 'CastError' ||
      errCode === 'INVALID_ID' ||
      errCode === 'NO_APPROVAL_MATRIX' ||
      errCode === 'NO_MATCHING_RULE';
    if (!isNoWorkflow) {
      await policyRepo.delete(policy._id);
      throw err;
    }
    await policyRepo.update(policy._id, { status: 'active' });
  }

  await policyRepo.addDocumentLog({
    policy_id: policy._id,
    version,
    file_name: req.file.originalname,
    action: 'Initial Upload',
    notes: 'Initial upload',
    description: 'Initial policy document upload',
    updated_by: userId
  });

  res.status(201).json({
    success: true,
    data: { ...policy.toObject(), file_url: url }
  });
});

export const updatePolicy = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const existing = await policyRepo.findById(policyId);
  if (!existing) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  const updateData = {};
  if (req.body.title !== undefined) updateData.title = req.body.title;
  if (req.body.category !== undefined) updateData.category = req.body.category;
  if (req.body.description !== undefined) updateData.description = req.body.description;
  if (req.body.policy_owner_id !== undefined) updateData.policy_owner_id = req.body.policy_owner_id || null;
  if (req.body.department_id !== undefined) {
    updateData.department_id = req.body.department_id || null;
    updateData.department = null;
    if (req.body.department_id) {
      const { DepartmentRepository } = await import('../repositories/departmentRepository.js');
      const departmentRepo = new DepartmentRepository(tenantDb);
      const dept = await departmentRepo.findById(req.body.department_id);
      if (dept) updateData.department = dept.name;
    }
  }
  if (req.body.effective_date !== undefined) updateData.effective_date = req.body.effective_date ? new Date(req.body.effective_date) : null;
  if (req.body.review_cycle !== undefined) updateData.review_cycle = req.body.review_cycle;
  if (req.body.review_date !== undefined) updateData.review_date = req.body.review_date ? new Date(req.body.review_date) : null;
  if (req.body.version !== undefined) updateData.version = req.body.version;
  if (req.body.status !== undefined) updateData.status = req.body.status;

  const policy = await policyRepo.update(policyId, updateData);
  let file_url = null;
  if (policy.file_path) {
    try {
      file_url = await getFileUrl(policy.file_path);
    } catch {
      // ignore
    }
  }
  res.json({
    success: true,
    data: { ...policy.toObject(), file_url }
  });
});

export const updatePolicyDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const userIdString = req.user?.userId || req.user?._id;
  if (!req.file) {
    throw new AppError('Policy document is required', 400, 'FILE_REQUIRED');
  }

  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const existing = await policyRepo.findById(policyId);
  if (!existing) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  if (existing.file_path) {
    try {
      await deleteFromS3(existing.file_path);
    } catch {
      // ignore
    }
  }

  const { key, url } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'policy'
  );

  const newVersion = incrementVersion(existing.version || 'v1.0');
  const notes = req.body.notes?.trim() || undefined;
  let userId = null;
  if (userIdString) {
    try {
      userId = new mongoose.Types.ObjectId(userIdString);
    } catch {
      // ignore
    }
  }

  // Get updater information for denormalization
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);

  let updatedByName = undefined;
  let updatedByTitle = undefined;
  
  if (userId) {
    const user = await userRepo.findById(userId);
    updatedByName = user?.first_name && user?.last_name 
      ? `${user.first_name} ${user.last_name}` 
      : (user?.email || undefined);

    const org = await orgRepo.findOne();
    if (org) {
      const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
      if (boardMember) {
        updatedByTitle = boardMember.position || boardMember.custom_position_title;
      }
    }
  }

  const policy = await policyRepo.update(policyId, {
    file_name: req.file.originalname,
    file_path: key,
    file_size: req.file.size,
    mime_type: req.file.mimetype,
    version: newVersion,
    uploaded_by: userId
  });

  await policyRepo.addDocumentLog({
    policy_id: policy._id,
    version: newVersion,
    file_name: req.file.originalname,
    action: 'Document Updated',
    notes: notes || undefined,
    description: notes || 'Policy document updated',
    updated_by: userId,
    updated_by_name: updatedByName,
    updated_by_title: updatedByTitle
  });

  res.json({
    success: true,
    data: { ...policy.toObject(), file_url: url }
  });
});

/**
 * Acknowledge an active policy for the current user.
 * Optionally stores drawn signature data.
 * Captures and denormalizes user name and title for PDF display.
 */
export const acknowledgePolicy = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const userIdString = req.user?.userId || req.user?._id;

  if (!userIdString) {
    throw new AppError('User ID not found in request', 401, 'USER_ID_MISSING');
  }

  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);

  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  if (policy.status !== 'active') {
    throw new AppError('Only active policies can be acknowledged', 400, 'POLICY_NOT_ACTIVE');
  }

  let userId;
  try {
    userId = new mongoose.Types.ObjectId(userIdString);
  } catch {
    throw new AppError('Invalid user ID format', 400, 'INVALID_USER_ID');
  }

  // Get user information for denormalization
  const user = await userRepo.findById(userId);
  let userName = user?.first_name && user?.last_name 
    ? `${user.first_name} ${user.last_name}` 
    : (user?.email || 'Unknown User');

  let userTitle = undefined;
  const org = await orgRepo.findOne();
  if (org) {
    const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
    if (boardMember) {
      userTitle = boardMember.position || boardMember.custom_position_title;
    }
  }

  const signatureData = typeof req.body?.signature_data === 'string' ? req.body.signature_data : null;
  const acknowledgement = await acknowledgementRepo.acknowledge(policyId, userId, signatureData, userName, userTitle);

  res.status(201).json({
    success: true,
    data: acknowledgement
  });
});

/**
 * Stream policy PDF via same-origin endpoint to avoid S3 CORS issues.
 */
export const streamPolicyPdf = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }
  if (!policy.file_path) {
    throw new AppError('Policy has no document', 404, 'NO_CONTENT');
  }

  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await getFileStream(policy.file_path, rangeHeader);

  res.setHeader('Content-Type', ContentType || 'application/pdf');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});

export const deletePolicy = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }
  if (policy.file_path) {
    try {
      await deleteFromS3(policy.file_path);
    } catch {
      // ignore
    }
  }
  await policyRepo.delete(policyId);
  res.json({
    success: true,
    message: 'Policy deleted successfully'
  });
});

/**
 * Review Policy
 * POST /platform/policies/:policyId/review
 * Body: {
 *   action: 'approved_no_changes' | 'updated' | 'rejected',
 *   comments: string (optional),
 *   next_review_date: ISO date string (optional),
 *   changes: object (if action === 'updated')
 * }
 */
export const reviewPolicy = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const { policyId } = req.params;
  const { action, comments, next_review_date, changes, e_signature } = req.body;

  // Validate action
  if (!['approved_no_changes', 'updated', 'rejected'].includes(action)) {
    throw new AppError('Invalid action. Must be approved_no_changes, updated, or rejected', 400, 'INVALID_ACTION');
  }

  // Require e-signature for approval and update actions
  if ((action === 'approved_no_changes' || action === 'updated') && !e_signature?.trim()) {
    throw new AppError('E-signature is required to confirm this action', 400, 'MISSING_E_SIGNATURE');
  }

  // Validate next_review_date is not in the past
  if (next_review_date) {
    const selectedDate = new Date(next_review_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    selectedDate.setHours(0, 0, 0, 0);
    
    if (selectedDate < today) {
      throw new AppError('Next review date cannot be in the past', 400, 'INVALID_REVIEW_DATE');
    }
  }

  const tenantDb = await getTenantConnection(orgId);
  const policyRepo = new PolicyRepository(tenantDb);
  const policy = await policyRepo.findById(policyId);

  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  // Get reviewer information for denormalization
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);

  let userObjectId;
  try {
    userObjectId = new mongoose.Types.ObjectId(userId);
  } catch {
    throw new AppError('Invalid user ID format', 400, 'INVALID_USER_ID');
  }

  const user = await userRepo.findById(userObjectId);
  let reviewerName = user?.first_name && user?.last_name 
    ? `${user.first_name} ${user.last_name}` 
    : (user?.email || 'Unknown User');

  let reviewerTitle = undefined;
  const org = await orgRepo.findOne();
  if (org) {
    const boardMember = await boardMemberRepo.findByUserId(userObjectId, org._id);
    if (boardMember) {
      reviewerTitle = boardMember.position || boardMember.custom_position_title;
    }
  }

  // Calculate next review date if not provided
  let calculatedNextReviewDate = next_review_date;
  if (!calculatedNextReviewDate && policy.review_cycle) {
    const today = new Date();
    const cycleMonths = {
      '3 months': 3,
      '6 months': 6,
      '12 months': 12,
      '24 months': 24
    };
    const months = cycleMonths[policy.review_cycle] || 12;
    const nextDate = new Date(today);
    nextDate.setMonth(nextDate.getMonth() + months);
    calculatedNextReviewDate = nextDate.toISOString();
  }

  // Build review history entry with e-signature and denormalized reviewer info
  const reviewEntry = {
    reviewed_by: userObjectId,
    reviewed_by_name: reviewerName,
    reviewed_by_title: reviewerTitle,
    reviewed_at: new Date(),
    action: action,
    comments: comments || null,
    version_reviewed: policy.version,
    next_review_date_set: calculatedNextReviewDate ? new Date(calculatedNextReviewDate) : null,
    e_signature: e_signature || null
  };

  // Handle different review actions
  if (action === 'approved_no_changes') {
    // Just add to review history and set next review date
    await policyRepo.update(policyId, {
      $push: { review_history: reviewEntry },
      reviewed_by: userObjectId,
      reviewed_by_name: reviewerName,
      reviewed_at: new Date(),
      review_date: calculatedNextReviewDate ? new Date(calculatedNextReviewDate) : policy.next_review_date,
      next_review_date: calculatedNextReviewDate ? new Date(calculatedNextReviewDate) : policy.next_review_date,
      is_under_review: false,
      status: 'active'
    });

    return res.json({
      success: true,
      message: 'Policy reviewed and approved without changes',
      data: {
        policyId,
        reviewed_at: new Date(),
        next_review_date: calculatedNextReviewDate
      }
    });
  }

  if (action === 'updated') {
    // Changes provided - increment version, reset acknowledgements, trigger workflow
    if (!changes) {
      throw new AppError('Changes required when action is "updated"', 400, 'MISSING_CHANGES');
    }

    // Increment version
    const newVersion = incrementVersion(policy.version);

    // Update policy with new version and reset acknowledgements
    const updateData = {
      ...changes,
      version: newVersion,
      $push: { review_history: reviewEntry },
      reviewed_by: userObjectId,
      reviewed_by_name: reviewerName,
      reviewed_at: new Date(),
      review_date: calculatedNextReviewDate ? new Date(calculatedNextReviewDate) : policy.next_review_date,
      next_review_date: calculatedNextReviewDate ? new Date(calculatedNextReviewDate) : policy.next_review_date,
      acknowledgements: [], // Reset acknowledgements for new version
      is_under_review: false,
      status: 'active'
    };

    const updatedPolicy = await policyRepo.update(policyId, updateData);

    // Trigger policy approval workflow again for new version
    try {
      const workflowService = new ApprovalWorkflowService(orgId);
      await workflowService.createPolicyApprovalRequest(
        policyId,
        userId,
        'policy_update_review'
      );
    } catch (workflowErr) {
      // Log but don't fail the review if workflow fails
      console.error('Error triggering policy approval workflow on update:', workflowErr);
    }

    return res.json({
      success: true,
      message: 'Policy reviewed and updated. New version created and workflow triggered for re-approvals.',
      data: {
        policyId,
        new_version: newVersion,
        reviewed_at: new Date(),
        next_review_date: calculatedNextReviewDate,
        acknowledgements_reset: true
      }
    });
  }

  if (action === 'rejected') {
    // Mark policy as expired/rejected and add to review history
    await policyRepo.update(policyId, {
      $push: { review_history: reviewEntry },
      reviewed_by: userObjectId,
      reviewed_by_name: reviewerName,
      reviewed_at: new Date(),
      is_under_review: false,
      status: 'expired'
    });

    return res.json({
      success: true,
      message: 'Policy review rejected. Policy marked as expired.',
      data: {
        policyId,
        rejected_at: new Date(),
        status: 'expired'
      }
    });
  }
});

/**
 * Get policies pending review (where review_date is today or has passed)
 * GET /platform/policies/pending-review
 */
export const getPoliciesPendingReview = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);

  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const policyRepo = new PolicyRepository(tenantDb);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find policies where review_date is today or in the past and status is not expired
  const pendingPolicies = await policyRepo.findByOrgId(orgId, {
    review_date: { $lte: new Date(today) },
    status: { $ne: 'expired' },
    is_under_review: false
  });

  res.json({
    success: true,
    data: pendingPolicies || []
  });
});

/**
 * Get all acknowledgements for a policy
 * GET /platform/policies/:policyId/acknowledgements
 */
export const getPolicyAcknowledgements = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);

  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);

  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  const acknowledgements = await acknowledgementRepo.findByPolicyId(policyId);
  
  res.json({
    success: true,
    data: acknowledgements || []
  });
});

/**
 * Get all approval steps for a policy
 * GET /platform/policies/:policyId/approvals
 */
export const getPolicyApprovals = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);

  const policyRepo = new PolicyRepository(tenantDb);
  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  // Get approval workflow data if available
  try {
    const approvals = await policyRepo.getApprovals(policyId);
    res.json({
      success: true,
      data: approvals || []
    });
  } catch (error) {
    // If approval data is not available, return empty
    res.json({
      success: true,
      data: []
    });
  }
});

/**
 * Get complete sign-off data (policy + logs + acknowledgements + approvals)
 * GET /platform/policies/:policyId/signoff
 */
export const getPolicySignOffData = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);

  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);

  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  // Fetch all related data
  const acknowledgements = await acknowledgementRepo.findByPolicyId(policyId);
  const documentLogs = await policyRepo.getDocumentLogs(policyId);
  
  // Get approval data if available
  let approvals = [];
  try {
    approvals = await policyRepo.getApprovals(policyId);
  } catch (error) {
    // Approvals may not be available
  }

  res.json({
    success: true,
    data: {
      policy,
      acknowledgements: acknowledgements || [],
      document_logs: documentLogs || [],
      approvals: approvals || []
    }
  });
});

/**
 * Download Policy Sign-Off Sheet PDF (generated on backend with proper decryption)
 * GET /platform/policies/:policyId/signoff/download
 */
export const downloadPolicySignOffPDF = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);

  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);

  // Get policy
  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  console.log('Policy review_history:', policy.review_history?.length || 0);
  console.log('Policy dates:', {
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    created_at: policy.created_at,
    updated_at: policy.updated_at
  });

  // Get organization for logo
  const org = await orgRepo.findOne();
  const logoUrl = org?.logo_url || process.env.LOGO || '';

  // Fetch all related data
  let acknowledgements = await acknowledgementRepo.findByPolicyId(policyId);
  let documentLogs = await policyRepo.getDocumentLogs(policyId);
  let approvals = [];
  let approvalRequest = null;
  
  try {
    approvals = await policyRepo.getApprovals(policyId);
    console.log('Approvals fetched for PDF:', JSON.stringify(approvals, null, 2));
  } catch (error) {
    console.error('Error fetching approvals:', error);
  }

  // Fetch approval workflow trail (ApprovalRequest) so PDF shows complete steps
  try {
    const approvalRequestSchema = (await import('../db/schemas/platform/approvalRequestSchema.js')).default;
    const ApprovalRequest = tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
    // Ensure referenced models exist for populate() on this tenant connection
    const positionSchema = (await import('../db/schemas/platform/positionSchema.js')).default;
    const departmentSchema = (await import('../db/schemas/platform/departmentSchema.js')).default;
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    const { UserRepository } = await import('../repositories/userRepository.js');
    new UserRepository(tenantDb);
    const approvalRequestId = policy.approval_request_id;

    const basePopulate = (q) => q
        .populate('submitted_by', 'first_name last_name email is_org_owner')
        .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
        .populate('approval_steps.approver_position_id', 'title')
        .populate('approval_steps.approver_department_id', 'name')
        .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
        .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
        .populate('escalations.escalated_by', 'first_name last_name email is_org_owner')
        .populate('escalations.escalated_to', 'first_name last_name email is_org_owner')
        .lean();

    if (approvalRequestId) {
      approvalRequest = await basePopulate(ApprovalRequest.findById(approvalRequestId));
    }

    // Fallback: if policy.approval_request_id is missing/stale, get the latest request by entity link.
    if (!approvalRequest) {
      approvalRequest = await basePopulate(
        ApprovalRequest.findOne({ entity_id: policy._id, entity_type: 'policy' }).sort({ created_at: -1 })
      );
    }
  } catch (err) {
    console.error('Error fetching approval request for policy PDF:', err);
    approvalRequest = null;
  }

  console.log('PDF Data Summary:', {
    policyId,
    acknowledgements: acknowledgements?.length || 0,
    documentLogs: documentLogs?.length || 0,
    approvals: approvals?.length || 0
  });

  // Debug: Check signature data
  if (acknowledgements && acknowledgements.length > 0) {
    console.log('First acknowledgement signature check:', {
      hasSignature: !!acknowledgements[0].signature_data,
      signaturePreview: acknowledgements[0].signature_data?.substring(0, 50) || 'none'
    });
  }

  // Debug: Check document logs
  if (documentLogs && documentLogs.length > 0) {
    console.log('First document log check:', {
      action: documentLogs[0].action || 'EMPTY',
      hasESignature: !!documentLogs[0].e_signature,
      eSignaturePreview: documentLogs[0].e_signature?.substring(0, 50) || 'none',
      createdAt: documentLogs[0].createdAt,
      created_at: documentLogs[0].created_at
    });
  }

  // Decrypt user names in document logs
  const masterKeyHex = getMasterKeyHex();
  for (const log of documentLogs) {
    if (log.updated_by && mongoose.Types.ObjectId.isValid(log.updated_by)) {
      try {
        const user = await userRepo.findById(log.updated_by);
        if (user) {
          // Decrypt user fields
          const firstName = isEncrypted(user.first_name) ? decrypt(user.first_name, masterKeyHex) : user.first_name;
          const lastName = isEncrypted(user.last_name) ? decrypt(user.last_name, masterKeyHex) : user.last_name;
          log.updated_by_name = `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown User';
        } else {
          log.updated_by_name = 'Unknown User';
        }
      } catch (error) {
        console.error('Error decrypting user:', error);
        log.updated_by_name = 'Unknown User';
      }
    }
  }

  // Decrypt approver names in approval steps
  for (const approval of approvals) {
    if (approval.reviewer_id && mongoose.Types.ObjectId.isValid(approval.reviewer_id)) {
      try {
        const user = await userRepo.findById(approval.reviewer_id);
        if (user) {
          const firstName = isEncrypted(user.first_name) ? decrypt(user.first_name, masterKeyHex) : user.first_name;
          const lastName = isEncrypted(user.last_name) ? decrypt(user.last_name, masterKeyHex) : user.last_name;
          approval.approver_name = `${firstName || ''} ${lastName || ''}`.trim() || approval.approver_name || 'Unknown Approver';
        }
      } catch (error) {
        console.error('Error decrypting approver:', error);
      }
    }
  }

  // Generate PDF
  const pdfBuffer = await generatePolicySignOffPDF(
    policy,
    acknowledgements || [],
    documentLogs || [],
    approvals || [],
    logoUrl,
    approvalRequest
  );

  // Set headers and send PDF
  const fileName = `${policy.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'policy'}_signoff_${Date.now()}.pdf`;
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  
  res.send(pdfBuffer);
});

/**
 * Download Policy Pack as ZIP (policy document + sign-off sheet)
 * GET /platform/policies/:policyId/signoff/pack-download
 */
export const downloadPolicyPackZip = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { policyId } = req.params;
  const tenantDb = await getTenantConnection(orgId);

  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);

  // Get policy
  const policy = await policyRepo.findById(policyId);
  if (!policy) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }

  // Get organization for logo
  const org = await orgRepo.findOne();
  // Prefer stored org logo, but never use a browser-only blob: URL inside Node/Puppeteer.
  let logoUrl = org?.logo_url || '';
  if (!logoUrl || String(logoUrl).startsWith('blob:')) {
    logoUrl = process.env.LOGO || '';
  }

  console.log('Logo URL for pack download:', {
    orgLogoUrl: org?.logo_url,
    envLogo: process.env.LOGO,
    finalLogoUrl: logoUrl,
    orgData: org ? { id: org._id, name: org.name } : null
  });

  // Fetch all related data for sign-off sheet
  let acknowledgements = await acknowledgementRepo.findByPolicyId(policyId);
  let documentLogs = await policyRepo.getDocumentLogs(policyId);
  let approvals = [];
  let approvalRequest = null;
  
  try {
    approvals = await policyRepo.getApprovals(policyId);
  } catch (error) {
    console.error('Error fetching approvals:', error);
  }

  // Fetch approval workflow trail (ApprovalRequest) so PDF shows complete steps
  try {
    const approvalRequestSchema = (await import('../db/schemas/platform/approvalRequestSchema.js')).default;
    const ApprovalRequest = tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
    // Ensure referenced models exist for populate() on this tenant connection
    const positionSchema = (await import('../db/schemas/platform/positionSchema.js')).default;
    const departmentSchema = (await import('../db/schemas/platform/departmentSchema.js')).default;
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    const { UserRepository } = await import('../repositories/userRepository.js');
    new UserRepository(tenantDb);
    const approvalRequestId = policy.approval_request_id;
    const basePopulate = (q) => q
        .populate('submitted_by', 'first_name last_name email is_org_owner')
        .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
        .populate('approval_steps.approver_position_id', 'title')
        .populate('approval_steps.approver_department_id', 'name')
        .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
        .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
        .populate('escalations.escalated_by', 'first_name last_name email is_org_owner')
        .populate('escalations.escalated_to', 'first_name last_name email is_org_owner')
        .lean();

    if (approvalRequestId) {
      approvalRequest = await basePopulate(ApprovalRequest.findById(approvalRequestId));
    }

    // Fallback: if policy.approval_request_id is missing/stale, get the latest request by entity link.
    if (!approvalRequest) {
      approvalRequest = await basePopulate(
        ApprovalRequest.findOne({ entity_id: policy._id, entity_type: 'policy' }).sort({ created_at: -1 })
      );
    }
  } catch (err) {
    console.error('Error fetching approval request for policy PDF:', err);
    approvalRequest = null;
  }

  // Decrypt user names in document logs
  const masterKeyHex = getMasterKeyHex();
  for (const log of documentLogs) {
    if (log.updated_by && mongoose.Types.ObjectId.isValid(log.updated_by)) {
      try {
        const user = await userRepo.findById(log.updated_by);
        if (user) {
          const firstName = isEncrypted(user.first_name) ? decrypt(user.first_name, masterKeyHex) : user.first_name;
          const lastName = isEncrypted(user.last_name) ? decrypt(user.last_name, masterKeyHex) : user.last_name;
          log.updated_by_name = `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown User';
        } else {
          log.updated_by_name = 'Unknown User';
        }
      } catch (error) {
        console.error('Error decrypting user:', error);
        log.updated_by_name = 'Unknown User';
      }
    }
  }

  // Decrypt approver names in approval steps
  for (const approval of approvals) {
    if (approval.reviewer_id && mongoose.Types.ObjectId.isValid(approval.reviewer_id)) {
      try {
        const user = await userRepo.findById(approval.reviewer_id);
        if (user) {
          const firstName = isEncrypted(user.first_name) ? decrypt(user.first_name, masterKeyHex) : user.first_name;
          const lastName = isEncrypted(user.last_name) ? decrypt(user.last_name, masterKeyHex) : user.last_name;
          approval.approver_name = `${firstName || ''} ${lastName || ''}`.trim() || approval.approver_name || 'Unknown Approver';
        }
      } catch (error) {
        console.error('Error decrypting approver:', error);
      }
    }
  }

  // Generate sign-off sheet PDF
  let signOffPdfBuffer;
  try {
    signOffPdfBuffer = await generatePolicySignOffPDF(
      policy,
      acknowledgements || [],
      documentLogs || [],
      approvals || [],
      logoUrl,
      approvalRequest
    );
  } catch (pdfError) {
    console.error('PDF Generation Error:', pdfError);
    throw new AppError('Failed to generate sign-off PDF: ' + pdfError.message, 500, 'PDF_GENERATION_ERROR');
  }

  console.log('Sign-off PDF buffer generated:', {
    isBuffer: Buffer.isBuffer(signOffPdfBuffer),
    isUint8Array: signOffPdfBuffer instanceof Uint8Array,
    length: signOffPdfBuffer?.length,
    type: typeof signOffPdfBuffer,
    constructor: signOffPdfBuffer?.constructor?.name
  });

  // Convert Uint8Array to Buffer if needed (puppeteer sometimes returns Uint8Array)
  if (signOffPdfBuffer instanceof Uint8Array && !Buffer.isBuffer(signOffPdfBuffer)) {
    signOffPdfBuffer = Buffer.from(signOffPdfBuffer);
  }

  // Validate PDF buffer
  if (!Buffer.isBuffer(signOffPdfBuffer) || signOffPdfBuffer.length === 0) {
    throw new AppError('Failed to generate sign-off PDF - invalid buffer returned', 500, 'PDF_GENERATION_ERROR');
  }

  // Create ZIP archive
  const archive = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });

  // Handle archive errors
  archive.on('error', (err) => {
    console.error('Archive error:', err);
    throw err;
  });

  // Set response headers for ZIP download
  const zipFileName = `${policy.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'policy'}_pack_${Date.now()}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

  // Pipe archive to response
  archive.pipe(res);

  // Add sign-off sheet PDF to ZIP
  const signOffFileName = `${policy.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'policy'}_signoff_sheet.pdf`;
  archive.append(signOffPdfBuffer, { name: signOffFileName });

  // Add a lightweight links file + JSON snapshot for auditing (avoid embedding huge attachments)
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const policyRecordUrl = `${frontendUrl}/policies/${policy._id}`;
  const policyAcknowledgeUrl = `${frontendUrl}/policies/acknowledge/${policy._id}`;
  const linksTxt = [
    `Policy record: ${policyRecordUrl}`,
    `Acknowledge/view page: ${policyAcknowledgeUrl}`,
    `Sign-off sheet download: ${frontendUrl}/api/platform/policies/${policy._id}/signoff/download`,
    `Policy pack download: ${frontendUrl}/api/platform/policies/${policy._id}/signoff/pack-download`,
    `Document logs (API): ${frontendUrl}/api/platform/policies/${policy._id}/logs`,
    `Approvals (API): ${frontendUrl}/api/platform/policies/${policy._id}/approvals`
  ].join('\n') + '\n';
  archive.append(linksTxt, { name: 'links.txt' });

  // Add policy document only when it's not too large (keeps exports lightweight)
  const MAX_EMBED_BYTES = 5 * 1024 * 1024; // 5MB
  const shouldEmbedDoc = !!policy.file_path && (!policy.file_size || policy.file_size <= MAX_EMBED_BYTES);
  if (shouldEmbedDoc) {
    try {
      const policyDocResult = await getFileStream(policy.file_path);
      const policyDocFileName = policy.file_name || `${policy.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'policy'}_document.pdf`;
      const chunks = [];
      for await (const chunk of policyDocResult.Body) chunks.push(chunk);
      const policyBuffer = Buffer.concat(chunks);
      archive.append(policyBuffer, { name: policyDocFileName });
    } catch (error) {
      console.error('Error fetching policy document:', error);
    }
  } else if (policy.file_path) {
    const msg = `Policy document not embedded due to size.\nS3 key: ${policy.file_path}\nOpen the policy record to view/download: ${policyRecordUrl}\n`;
    archive.append(msg, { name: 'policy-document-link.txt' });
  }

  // Finalize the archive
  await archive.finalize();
});


