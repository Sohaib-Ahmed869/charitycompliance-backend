import mongoose from 'mongoose';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';
import assetSchema from '../db/schemas/platform/assetSchema.js';
import itRegisterSchema from '../db/schemas/platform/itRegisterSchema.js';

const PORTALS = new Set(['paypal', 'stripe', 'gofundme', 'other']);

function getModels(tenantDb) {
  const ApprovalRequest = tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
  const ApprovalMatrix = tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
  const Asset = tenantDb.models.Asset || tenantDb.model('Asset', assetSchema);
  const ITRegister = tenantDb.models.ITRegister || tenantDb.model('ITRegister', itRegisterSchema);
  return { ApprovalRequest, ApprovalMatrix, Asset, ITRegister };
}

export const getSweepFundsWorkflows = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { ApprovalMatrix } = getModels(tenantDb);
  const rows = await ApprovalMatrix.find({
    org_id: org._id,
    is_active: true,
    rules: { $elemMatch: { action_type: 'sweep_funds', is_active: true } }
  })
    .select('name workflow_category workflow_type priority rules')
    .sort({ priority: -1, createdAt: -1 })
    .lean();

  res.json({ success: true, data: rows });
});

export const initiateSweepFundsTransfer = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { Asset, ITRegister } = getModels(tenantDb);
  const {
    sourcePortal,
    sourceAccountIdentifier,
    destinationAssetId,
    amount,
    comments = '',
    receiptFiles = []
  } = req.body || {};

  const portal = String(sourcePortal || '').toLowerCase();
  if (!PORTALS.has(portal)) throw new AppError('Invalid source portal', 400, 'INVALID_SOURCE_PORTAL');
  if (!mongoose.Types.ObjectId.isValid(destinationAssetId || '')) {
    throw new AppError('Destination bank account is required', 400, 'DESTINATION_REQUIRED');
  }

  const destinationAsset = await Asset.findOne({
    _id: destinationAssetId,
    category: 'Banking Details'
  }).lean();
  if (!destinationAsset) throw new AppError('Destination bank details not found', 404, 'DESTINATION_NOT_FOUND');

  const itRegister = await ITRegister.findOne({ org_id: org._id }).lean();
  const assignments = Array.isArray(itRegister?.sweep_funds_access) ? itRegister.sweep_funds_access : [];
  const userId = String(req.user?.userId || '');
  const isAdminUser =
    req.user?.is_org_owner === true ||
    req.user?.role === 'admin' ||
    (Array.isArray(req.user?.roles) && req.user.roles.includes('admin'));
  const canInitiate = assignments.some((a) => a?.active !== false && String(a?.assignedUserId) === userId && String(a?.portal || '').toLowerCase() === portal);
  if (!canInitiate && !isAdminUser) {
    throw new AppError('You do not have assigned access for this portal', 403, 'SWEEP_PORTAL_ACCESS_REQUIRED');
  }

  const workflowService = new ApprovalWorkflowService(req.orgId);
  const created = await workflowService.createSweepFundsApprovalRequest(
    {
      source_portal: portal,
      source_account_identifier: sourceAccountIdentifier || '',
      destination_asset_id: destinationAsset._id,
      destination_account_label: destinationAsset.asset_name || destinationAsset.type || 'Bank account',
      amount: Number(amount || 0),
      comments,
      receipt_files: Array.isArray(receiptFiles) ? receiptFiles : []
    },
    req.user.userId
  );

  res.status(201).json({ success: true, data: created });
});

export const approveSweepFundsTransfer = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const { ApprovalRequest } = getModels(tenantDb);
  const request = await ApprovalRequest.findById(req.params.transferId);
  if (!request || request.request_type !== 'sweep_funds') {
    throw new AppError('Sweep funds request not found', 404, 'SWEEP_NOT_FOUND');
  }
  if (request.status !== 'pending') {
    throw new AppError(`Cannot approve request with status ${request.status}`, 400, 'SWEEP_INVALID_STATUS');
  }

  const currentStepIndex = (request.approval_steps || []).findIndex((step, index, arr) => {
    if (request.approval_type === 'sequential') {
      return step.status === 'pending' && (index === 0 || arr[index - 1]?.status === 'approved');
    }
    return step.status === 'pending';
  });
  if (currentStepIndex < 0) throw new AppError('No pending approval step found', 400, 'NO_PENDING_STEP');

  const workflowService = new ApprovalWorkflowService(req.orgId);
  const updated = await workflowService.processApproval(
    request._id,
    currentStepIndex,
    req.user.userId,
    'approved',
    req.body?.comments || '',
    req.ip || req.connection?.remoteAddress,
    req.get('user-agent'),
    null,
    null
  );

  updated.sweep_funds = updated.sweep_funds || {};
  updated.sweep_funds.audit_trail = Array.isArray(updated.sweep_funds.audit_trail) ? updated.sweep_funds.audit_trail : [];
  updated.sweep_funds.audit_trail.push({
    action: updated.status === 'approved' ? 'fully_approved' : 'step_approved',
    by_user_id: req.user.userId,
    comments: req.body?.comments || '',
    created_at: new Date()
  });
  updated.markModified('sweep_funds');
  await updated.save();

  res.json({ success: true, data: updated });
});

export const getSweepFundsHistory = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { ApprovalRequest } = getModels(tenantDb);
  const rows = await ApprovalRequest.find({
    org_id: org._id,
    request_type: 'sweep_funds'
  })
    .populate('submitted_by', 'first_name last_name email')
    .populate('approval_steps.approver_user_id', 'first_name last_name email')
    .populate('sweep_funds.destination_asset_id', 'asset_name type')
    .sort({ created_at: -1 })
    .lean();

  res.json({ success: true, data: rows });
});
