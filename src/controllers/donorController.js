/**
 * Donor Controller
 *
 * HTTP handlers for donor register.
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { DonorService } from '../services/donorService.js';
import { getTenantConnection } from '../db/connectionManager.js';

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
  const tenantDb = await getTenantConnection(orgId);
  const service = new DonorService(orgId, tenantDb);

  const refund = await service.initiateDonorRefund(req.body);

  res.status(201).json({
    success: true,
    data: refund
  });
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
 * Submit public donor refund form
 */
export const submitDonorRefundPublicForm = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const refund = await service.submitPublicRefundForm(token, req.body);

  res.status(201).json({
    success: true,
    data: refund
  });
});

/**
 * Get donor refund payment acknowledgement context
 */
export const getDonorRefundPaymentAckContext = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const context = await service.getDonorRefundPaymentAckContext(token);

  res.json({
    success: true,
    data: context
  });
});

/**
 * Submit donor refund payment acknowledgement
 */
export const submitDonorRefundPaymentAck = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

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
 * Initiate donor refund workflow
 */
export const initiateDonorRefundWorkflow = asyncHandler(async (req, res) => {
  const donorId = req.params.donorId;
  const tenantDb = await getTenantConnection(req.orgId);
  const service = new DonorService(req.orgId, tenantDb);

  const workflow = await service.initiateDonorRefundWorkflow(donorId, req.body);

  res.json({
    success: true,
    data: workflow
  });
});

