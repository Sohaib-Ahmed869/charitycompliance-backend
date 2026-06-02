/**
 * Donor Controller
 *
 * HTTP handlers for donor register.
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { DonorService } from '../services/donorService.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { getRouterConnection } from '../config/database.js';

const REFUND_TOKEN_LOOKUP_COL = 'donor_refund_token_lookup';

async function resolveOrgFromRefundToken(token) {
  const routerDb = getRouterConnection();
  const doc = await routerDb.collection(REFUND_TOKEN_LOOKUP_COL).findOne({ token });
  if (!doc?.orgId) throw new AppError('Invalid or expired refund link', 404, 'REFUND_NOT_FOUND');
  const tenantDb = await getTenantConnection(doc.orgId);
  return { orgId: doc.orgId, tenantDb };
}

async function resolveOrgFromRefundPaymentAckToken(ackToken) {
  const routerDb = getRouterConnection();
  const doc = await routerDb.collection(REFUND_TOKEN_LOOKUP_COL).findOne({ payment_ack_token: ackToken });
  if (!doc?.orgId) throw new AppError('Invalid or expired acknowledgement link', 404, 'REFUND_NOT_FOUND');
  const tenantDb = await getTenantConnection(doc.orgId);
  return { orgId: doc.orgId, tenantDb };
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

/**
 * Initiate a donor refund request
 */
export const initiateDonorRefund = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const donorId = req.params.donorId;
  const userId = req.user?.userId || req.userId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const refund = await service.initiateDonorRefund(donorId, userId, req.body);

  res.status(201).json({
    success: true,
    data: refund
  });
});

/**
 * Manually record a donor refund — bookkeeping entry that bypasses the
 * standard donor-initiated workflow. Used when the donor isn't in the
 * Donor Register (small one-off donors) or when the refund happened
 * out-of-band and just needs to be on the record.
 */
export const createManualDonorRefund = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);
  const refund = await service.createManualDonorRefund(userId, req.body);
  res.status(201).json({ success: true, data: refund });
});

/**
 * Get a single refund by id — works for BOTH donor and project refunds
 * because they share the `project_refunds` collection. Used by the
 * approval detail page when a refunds-category approval is opened, so
 * approvers can see who / what they're approving.
 */
export const getRefundById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const { DonorRefundRepository } = await import('../repositories/donorRefundRepository.js');
  const repo = new DonorRefundRepository(tenantDb);
  const refund = await repo.findById(req.params.refundId);
  if (!refund) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Refund not found' }
    });
  }
  res.json({ success: true, data: refund });
});

/**
 * List donor refunds
 */
export const listDonorRefunds = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const filters = {
    status: req.query.status,
    donorId: req.query.donorId,
    search: req.query.search
  };

  const refunds = await service.listDonorRefunds(filters);

  res.json({
    success: true,
    data: refunds
  });
});

/**
 * Submit public donor refund form (public — no auth; resolves org from token)
 */
export const submitDonorRefundPublicForm = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const { orgId, tenantDb } = await resolveOrgFromRefundToken(token);
  const service = new DonorService(orgId, tenantDb);

  const refund = await service.submitPublicRefundForm(token, req.body);

  res.status(201).json({
    success: true,
    data: refund
  });
});

/**
 * Get donor refund payment acknowledgement context (public — no auth)
 */
export const getDonorRefundPaymentAckContext = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const { orgId, tenantDb } = await resolveOrgFromRefundPaymentAckToken(token);
  const service = new DonorService(orgId, tenantDb);

  const context = await service.getDonorRefundPaymentAckContext(token);

  res.json({
    success: true,
    data: context
  });
});

/**
 * Submit donor refund payment acknowledgement (public — no auth)
 */
export const submitDonorRefundPaymentAck = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const { orgId, tenantDb } = await resolveOrgFromRefundPaymentAckToken(token);
  const service = new DonorService(orgId, tenantDb);

  const ack = await service.submitDonorRefundPaymentAck(token, req.body);

  res.json({
    success: true,
    data: ack
  });
});

/**
 * Start donor refund processing
 */
export const startDonorRefundProcessing = asyncHandler(async (req, res) => {
  const refundId = req.params.refundId;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const refund = await service.startDonorRefundProcessing(refundId);

  res.json({
    success: true,
    data: refund
  });
});

/**
 * Record donor refund payment sent
 */
export const recordDonorRefundPaymentSent = asyncHandler(async (req, res) => {
  const refundId = req.params.refundId;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const refund = await service.recordDonorRefundPaymentSent(refundId, req.body);

  res.json({
    success: true,
    data: refund
  });
});

/**
 * Complete donor refund processing
 */
export const completeDonorRefundProcessing = asyncHandler(async (req, res) => {
  const refundId = req.params.refundId;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const refund = await service.completeDonorRefundProcessing(refundId);

  res.json({
    success: true,
    data: refund
  });
});

/**
 * Initiate donor refund workflow (route param is :refundId)
 */
export const initiateDonorRefundWorkflow = asyncHandler(async (req, res) => {
  const refundId = req.params.refundId;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const workflow = await service.initiateDonorRefundWorkflow(refundId, req.body);

  res.json({
    success: true,
    data: workflow
  });
});

