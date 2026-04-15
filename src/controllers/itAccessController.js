import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import mongoose from 'mongoose';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import offboardingRequestSchema from '../db/schemas/platform/offboardingRequestSchema.js';
import accessChangeLogSchema from '../db/schemas/platform/accessChangeLogSchema.js';
import itRegisterSchema from '../db/schemas/platform/itRegisterSchema.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import assetSchema from '../db/schemas/platform/assetSchema.js';

const DEFAULT_STEPS = [
  'Revoke application/platform access',
  'Disable organization email',
  'Recover devices and credentials',
  'Remove shared drives and shared resources',
  'Update emergency/primary contacts',
  'Archive user data and records'
];

function getModels(tenantDb) {
  const OffboardingRequest = tenantDb.models.OffboardingRequest || tenantDb.model('OffboardingRequest', offboardingRequestSchema);
  const AccessChangeLog = tenantDb.models.AccessChangeLog || tenantDb.model('AccessChangeLog', accessChangeLogSchema);
  const ITRegister = tenantDb.models.ITRegister || tenantDb.model('ITRegister', itRegisterSchema);
  const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const Asset = tenantDb.models.Asset || tenantDb.model('Asset', assetSchema);
  return { OffboardingRequest, AccessChangeLog, ITRegister, BoardMember, Asset };
}

const SUBSCRIPTION_CATEGORIES = new Set(['Subscription', 'Software', 'Cloud Service']);
const MAINTENANCE_KEYS = ['backupVerified', 'softwareUpdated', 'accessReviewed', 'integrityChecked', 'securityAudit'];
const MAINTENANCE_WINDOW_DAYS = 30;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function normalizeChecklist(checklist = {}) {
  const now = new Date();
  const next = {};
  MAINTENANCE_KEYS.forEach((key) => {
    const row = checklist?.[key] || {};
    const parsedDate = row.date ? new Date(row.date) : null;
    next[key] = {
      completed: row.completed === true,
      date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      person: String(row.person || '').trim(),
      userId: row.userId && mongoose.Types.ObjectId.isValid(row.userId) ? new mongoose.Types.ObjectId(row.userId) : null,
      updatedAt: now
    };
  });
  return next;
}

function computeMaintenanceStatus(checklist = {}) {
  const today = startOfDay(new Date());
  const overdueCutoff = new Date(today);
  overdueCutoff.setDate(overdueCutoff.getDate() - MAINTENANCE_WINDOW_DAYS);

  let completedCount = 0;
  let overdueCount = 0;
  MAINTENANCE_KEYS.forEach((key) => {
    const row = checklist?.[key] || {};
    const checkedAt = row.date ? startOfDay(new Date(row.date)) : null;
    const recent = checkedAt && checkedAt >= overdueCutoff;
    if (row.completed === true && recent) completedCount += 1;
    if (!recent) overdueCount += 1;
  });

  if (overdueCount > 0) return 'overdue';
  if (completedCount === MAINTENANCE_KEYS.length) return 'all_good';
  return 'attention';
}

function mapMaintenanceSummary(asset) {
  const checklist = normalizeChecklist(asset?.maintenanceChecklist || {});
  const maintenanceStatus = computeMaintenanceStatus(checklist);
  return {
    ...asset,
    maintenanceChecklist: checklist,
    maintenanceStatus
  };
}

export const getMfaStatus = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const userRepo = new UserRepository(tenantDb);
  const users = await userRepo.User.find({ status: { $in: ['active', 'suspended'] } })
    .select('first_name last_name email status mfa_enabled mfa_secret last_login_at')
    .sort({ first_name: 1, last_name: 1 });

  const data = users.map((u) => {
    const status = u.mfa_enabled ? 'Enabled' : (u.mfa_secret ? 'Disabled' : 'Not Set Up');
    return {
      userId: u._id?.toString(),
      name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || (u.email || 'User'),
      email: u.email || '',
      accountStatus: u.status,
      mfaStatus: status,
      enrolled: status === 'Enabled',
      enrolledAt: status === 'Enabled' ? (u.updatedAt || null) : null,
      method: status === 'Enabled' ? 'totp' : null,
      lastLoginAt: u.last_login_at || null
    };
  });

  const { ITRegister } = getModels(tenantDb);
  await ITRegister.findOneAndUpdate(
    { org_id: org._id },
    {
      $set: {
        mfa_tracking: data.map((d) => ({
          user_id: d.userId,
          enrolled: d.enrolled,
          enrolled_at: d.enrolledAt,
          method: d.method || 'totp'
        })),
        updated_by: req.user?.userId || null
      }
    },
    { upsert: true, new: true }
  );

  res.json({ success: true, data });
});

export const createAccessLogEntry = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { AccessChangeLog } = getModels(tenantDb);
  const { userId = null, boardMemberId = null, action = 'access_change', module = 'it_access', details = {} } = req.body || {};
  const entry = await AccessChangeLog.create({
    org_id: org._id,
    user_id: userId || null,
    board_member_id: boardMemberId || null,
    changed_by: req.user?.userId || null,
    action,
    module,
    details,
    created_at: new Date()
  });

  res.status(201).json({ success: true, data: entry });
});

export const initiateOffboarding = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { userId } = req.params;
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const { OffboardingRequest, AccessChangeLog } = getModels(tenantDb);
  const existing = await OffboardingRequest.findOne({
    org_id: org._id,
    user_id: user._id,
    status: 'in_progress'
  }).lean();
  if (existing) {
    return res.json({ success: true, data: existing });
  }

  const request = await OffboardingRequest.create({
    org_id: org._id,
    user_id: user._id,
    initiated_by: req.user?.userId || null,
    status: 'in_progress',
    mfa_required: true,
    steps: DEFAULT_STEPS.map((name) => ({ name, completed: false })),
    metadata: { mfa_verified: false }
  });

  await AccessChangeLog.create({
    org_id: org._id,
    user_id: user._id,
    changed_by: req.user?.userId || null,
    action: 'offboarding_initiated',
    module: 'offboarding',
    details: { offboarding_request_id: request._id?.toString() },
    created_at: new Date()
  });

  res.status(201).json({ success: true, data: request });
});

export const updateOffboardingStep = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { offboardingId, stepId } = req.params;
  const { notes = '', overrideReason = '', mfaVerified = false } = req.body || {};
  const { OffboardingRequest, AccessChangeLog, BoardMember } = getModels(tenantDb);
  const userRepo = new UserRepository(tenantDb);

  const request = await OffboardingRequest.findOne({ _id: offboardingId, org_id: org._id });
  if (!request) throw new AppError('Offboarding request not found', 404, 'NOT_FOUND');
  if (request.status !== 'in_progress') throw new AppError('Offboarding request is not active', 400, 'INVALID_STATUS');

  const stepIndex = request.steps.findIndex((s) => String(s._id) === String(stepId));
  if (stepIndex < 0) throw new AppError('Offboarding step not found', 404, 'STEP_NOT_FOUND');
  const step = request.steps[stepIndex];
  if (step.completed) throw new AppError('Step already completed', 400, 'STEP_ALREADY_DONE');

  const skippedPriorStep = request.steps.slice(0, stepIndex).find((s) => !s.completed);
  if (skippedPriorStep && !String(overrideReason || '').trim()) {
    throw new AppError('Cannot skip steps without override reason', 400, 'OVERRIDE_REASON_REQUIRED');
  }

  if (stepIndex === 0 && !mfaVerified) {
    throw new AppError('MFA verification is required for access revocation', 400, 'MFA_REQUIRED');
  }

  step.completed = true;
  step.completed_by = req.user?.userId || null;
  step.completed_at = new Date();
  step.notes = String(notes || '');
  step.override_reason = String(overrideReason || '');
  request.markModified('steps');

  const allDone = request.steps.every((s) => s.completed);
  if (allDone) {
    const user = await userRepo.findById(request.user_id);
    if (user) {
      const originalEmail = String(user.email || '').trim();
      const originalName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
      const safeLocal = originalEmail.includes('@') ? originalEmail.split('@')[0] : 'user';
      const offboardedEmail = `offboarded+${Date.now()}-${safeLocal}@offboarded.local`;
      request.metadata = {
        ...(request.metadata || {}),
        original_email: originalEmail || null,
        original_name: originalName || null
      };
      request.markModified('metadata');
      await userRepo.update(user._id, {
        status: 'inactive',
        locked: true,
        mfa_enabled: false,
        mfa_secret: null,
        email: offboardedEmail
      });
    }

    await BoardMember.updateMany(
      { org_id: org._id, user_id: request.user_id, is_active: true },
      {
        $set: {
          is_active: false,
          status: 'removed',
          has_system_access: false,
          offboarded_at: new Date(),
          user_id: null,
          position_id: null
        }
      }
    );

    request.status = 'completed';
    request.completed_at = new Date();
  }

  await request.save();

  await AccessChangeLog.create({
    org_id: org._id,
    user_id: request.user_id,
    changed_by: req.user?.userId || null,
    action: allDone ? 'offboarding_completed' : 'offboarding_step_completed',
    module: 'offboarding',
    details: {
      offboarding_request_id: request._id?.toString(),
      step_id: String(step._id),
      step_name: step.name,
      notes: step.notes,
      override_reason: step.override_reason
    },
    created_at: new Date()
  });

  res.json({ success: true, data: request });
});

export const listOffboardingRequests = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { OffboardingRequest } = getModels(tenantDb);
  const rows = await OffboardingRequest.find({ org_id: org._id })
    .populate('user_id', 'first_name last_name email status mfa_enabled')
    .populate('initiated_by', 'first_name last_name email')
    .populate('steps.completed_by', 'first_name last_name email')
    .sort({ createdAt: -1 })
    .lean();

  res.json({ success: true, data: rows });
});

export const listSweepFundsAccessAssignments = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { ITRegister } = getModels(tenantDb);
  const doc = await ITRegister.findOne({ org_id: org._id }).lean();
  const rows = Array.isArray(doc?.sweep_funds_access) ? doc.sweep_funds_access : [];
  res.json({ success: true, data: rows });
});

export const createSweepFundsAccessAssignment = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { ITRegister } = getModels(tenantDb);
  const payload = req.body || {};
  const row = {
    portal: payload.portal || 'other',
    portalLabel: payload.portalLabel || '',
    portalAccountIdentifier: payload.portalAccountIdentifier || '',
    assignedUserId: payload.assignedUserId || null,
    assignedPersonName: payload.assignedPersonName || '',
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    notes: payload.notes || '',
    active: payload.active !== false,
    created_by: req.user?.userId || null,
    updated_by: req.user?.userId || null,
    created_at: new Date(),
    updated_at: new Date()
  };

  if (!row.assignedUserId) {
    throw new AppError('Assigned user is required', 400, 'ASSIGNED_USER_REQUIRED');
  }

  const updated = await ITRegister.findOneAndUpdate(
    { org_id: org._id },
    {
      $push: { sweep_funds_access: row },
      $set: { updated_by: req.user?.userId || null }
    },
    { upsert: true, new: true }
  );

  const created = (updated?.sweep_funds_access || []).slice(-1)[0] || null;
  res.status(201).json({ success: true, data: created });
});

export const updateSweepFundsAccessAssignment = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { assignmentId } = req.params;
  const { ITRegister } = getModels(tenantDb);
  const doc = await ITRegister.findOne({ org_id: org._id });
  if (!doc) throw new AppError('IT register not found', 404, 'IT_REGISTER_NOT_FOUND');

  const idx = (doc.sweep_funds_access || []).findIndex((a) => String(a?._id) === String(assignmentId));
  if (idx < 0) throw new AppError('Assignment not found', 404, 'ASSIGNMENT_NOT_FOUND');

  const next = doc.sweep_funds_access[idx].toObject ? doc.sweep_funds_access[idx].toObject() : { ...doc.sweep_funds_access[idx] };
  const body = req.body || {};
  if (body.portal !== undefined) next.portal = body.portal;
  if (body.portalLabel !== undefined) next.portalLabel = body.portalLabel;
  if (body.portalAccountIdentifier !== undefined) next.portalAccountIdentifier = body.portalAccountIdentifier;
  if (body.assignedUserId !== undefined) next.assignedUserId = body.assignedUserId || null;
  if (body.assignedPersonName !== undefined) next.assignedPersonName = body.assignedPersonName;
  if (body.permissions !== undefined) next.permissions = Array.isArray(body.permissions) ? body.permissions : [];
  if (body.notes !== undefined) next.notes = body.notes;
  if (body.active !== undefined) next.active = !!body.active;
  next.updated_by = req.user?.userId || null;
  next.updated_at = new Date();

  if (!next.assignedUserId) {
    throw new AppError('Assigned user is required', 400, 'ASSIGNED_USER_REQUIRED');
  }

  doc.sweep_funds_access[idx] = next;
  doc.markModified('sweep_funds_access');
  await doc.save();

  res.json({ success: true, data: doc.sweep_funds_access[idx] });
});

export const updateSubscriptionMaintenanceChecklist = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const { assetId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(assetId)) {
    throw new AppError('Invalid subscription ID', 400, 'INVALID_SUBSCRIPTION_ID');
  }
  const { Asset } = getModels(tenantDb);
  const asset = await Asset.findById(assetId);
  if (!asset) throw new AppError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
  if (!SUBSCRIPTION_CATEGORIES.has(String(asset.category || ''))) {
    throw new AppError('Maintenance checklist only applies to subscription assets', 400, 'INVALID_SUBSCRIPTION_CATEGORY');
  }

  const incomingChecklist = req.body?.maintenanceChecklist || req.body || {};
  const mergedChecklist = normalizeChecklist({
    ...(asset.maintenanceChecklist?.toObject ? asset.maintenanceChecklist.toObject() : asset.maintenanceChecklist || {}),
    ...incomingChecklist
  });
  const maintenanceStatus = computeMaintenanceStatus(mergedChecklist);

  asset.maintenanceChecklist = mergedChecklist;
  asset.maintenanceStatus = maintenanceStatus;
  asset.updated_by = req.user?.userId || null;
  await asset.save();

  const saved = asset.toObject();
  res.json({ success: true, data: mapMaintenanceSummary(saved) });
});

export const getSubscriptionsMaintenanceDue = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const { Asset } = getModels(tenantDb);
  const rows = await Asset.find({ category: { $in: Array.from(SUBSCRIPTION_CATEGORIES) }, status: { $ne: 'retired' } })
    .select('_id asset_name category type assigned_to maintenanceChecklist maintenanceStatus updatedAt')
    .populate('assigned_to', 'first_name last_name email')
    .sort({ updatedAt: -1 })
    .lean();

  const mapped = rows
    .map((row) => mapMaintenanceSummary(row))
    .filter((row) => row.maintenanceStatus !== 'all_good');

  res.json({ success: true, data: mapped });
});
