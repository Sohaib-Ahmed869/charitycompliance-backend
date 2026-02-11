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

export const getPolicies = asyncHandler(async (req, res) => {
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

/**
 * Get policy details for the current user (includes acknowledgement state)
 * Used for staff-side "read & acknowledge" flow.
 */
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
    notes: 'Initial upload',
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
    notes: notes || undefined,
    updated_by: userId
  });

  res.json({
    success: true,
    data: { ...policy.toObject(), file_url: url }
  });
});

/**
 * Acknowledge an active policy for the current user.
 * Optionally stores drawn signature data.
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

  const signatureData = typeof req.body?.signature_data === 'string' ? req.body.signature_data : null;
  const acknowledgement = await acknowledgementRepo.acknowledge(policyId, userId, signatureData);

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
