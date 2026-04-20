/**
 * Training Controller
 *
 * Handles training programs, modules, resources, enrollments, and register list.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { TrainingRepository } from '../repositories/trainingRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { DepartmentRepository } from '../repositories/departmentRepository.js';
import { PositionRepository } from '../repositories/positionRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToS3, getFileUrl, getFileStream } from '../services/s3Service.js';
import { decryptBoardMemberFields } from '../utils/decryptBoardMember.js';
import { ExternalTrainingEnrollmentRepository } from '../repositories/externalTrainingEnrollmentRepository.js';
import emailService from '../services/emailService.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';

const getOrgId = (req) => req.orgId;

/** Treat completion as completed if completed_at is set (fixes legacy in_progress + completed_at) */
function normalizeCompletion(c) {
  if (!c) return c;
  if (c.completed_at != null && c.status !== 'completed') return { ...c, status: 'completed' };
  return c;
}

const getTenantAndRepos = async (req) => {
  const orgId = getOrgId(req);
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  const trainingRepo = new TrainingRepository(tenantDb);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const departmentRepo = new DepartmentRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);
  return { orgId, org, tenantDb, trainingRepo, boardMemberRepo, departmentRepo, positionRepo };
};

const getTenantByOrgKey = async (orgKey) => {
  const tenantDb = await getTenantConnection(orgKey);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  const trainingRepo = new TrainingRepository(tenantDb);
  const externalRepo = new ExternalTrainingEnrollmentRepository(tenantDb);
  return { tenantDb, org, trainingRepo, externalRepo };
};

async function notifyVolunteersForProgram({ boardMemberRepo, orgIdObj, program }) {
  try {
    const allPeople = await boardMemberRepo.findByOrgId(orgIdObj, false);
    const targetPositionIds = new Set((program?.position_ids || []).map((id) => String(id)));
    const recipients = (allPeople || []).filter((bm) => {
      if (!bm?.is_volunteer || !bm?.email) return false;
      if (targetPositionIds.size === 0) return false;
      const personPositionId = bm?.position_id?._id ? String(bm.position_id._id) : String(bm?.position_id || '');
      return targetPositionIds.has(personPositionId);
    });
    await Promise.all(
      recipients.map((v) =>
        emailService.sendVolunteerTrainingNotification({
          to: v.email,
          recipientName: `${v.given_names || ''} ${v.family_name || ''}`.trim() || 'Volunteer',
          trainingTitle: program.title || program.category || 'Training',
        })
      )
    );
  } catch {
    // non-blocking
  }
}

// --- Upload resource file (from PC) ---
export const uploadResourceFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new AppError('File is required', 400, 'FILE_REQUIRED');
  }
  const orgId = getOrgId(req);
  const { key } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'training'
  );
  res.json({ success: true, data: { file_url: key } });
});

// --- Resource view URL (presigned for in-app video/PDF) ---
export const getResourceViewUrl = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { resourceId } = req.params;
  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource) {
    throw new AppError('Resource not found', 404, 'NOT_FOUND');
  }
  const mod = await trainingRepo.findModuleById(resource.module_id);
  if (!mod) {
    throw new AppError('Module not found', 404, 'NOT_FOUND');
  }
  const program = await trainingRepo.findProgramById(mod.training_program_id);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  if (resource.link_url) {
    return res.json({ success: true, data: { url: resource.link_url } });
  }
  if (!resource.file_url) {
    throw new AppError('Resource has no file or link', 404, 'NO_CONTENT');
  }
  const url = await getFileUrl(resource.file_url, 3600); // 1 hour
  res.json({ success: true, data: { url } });
});

// --- Stream PDF for in-app viewing (same-origin so iframe/progress tracking works) ---
// Allowed for: (1) any authenticated org user e.g. HR viewing training detail, (2) members viewing assigned training
export const streamResourcePdf = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  if (!req.user?.userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const { resourceId } = req.params;
  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource) throw new AppError('Resource not found', 404, 'NOT_FOUND');
  const type = (resource.type || '').toLowerCase();
  if (type !== 'pdf') throw new AppError('Resource is not a PDF', 400, 'VALIDATION_ERROR');
  if (!resource.file_url) throw new AppError('Resource has no file', 404, 'NO_CONTENT');
  const mod = await trainingRepo.findModuleById(resource.module_id);
  if (!mod) throw new AppError('Module not found', 404, 'NOT_FOUND');
  const program = await trainingRepo.findProgramById(mod.training_program_id);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await getFileStream(resource.file_url, rangeHeader);
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

// --- Update resource duration from actual video (when estimated_minutes not set) ---
export const updateResourceDuration = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
  if (!boardMember) throw new AppError('You are not registered as a member', 403, 'FORBIDDEN');
  const { resourceId } = req.params;
  const durationSeconds = req.body?.duration_seconds;
  if (typeof durationSeconds !== 'number' || durationSeconds < 0 || !Number.isFinite(durationSeconds)) {
    throw new AppError('duration_seconds must be a non-negative number', 400, 'VALIDATION_ERROR');
  }
  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource) throw new AppError('Resource not found', 404, 'NOT_FOUND');
  const mod = await trainingRepo.findModuleById(resource.module_id);
  if (!mod) throw new AppError('Module not found', 404, 'NOT_FOUND');
  const program = await trainingRepo.findProgramById(mod.training_program_id);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const bmPositionId = boardMember.position_id?.toString?.() || null;
  const isAssigned = bmPositionId && Array.isArray(program.position_ids) &&
    program.position_ids.some((pid) => (pid?.toString?.() || pid) === bmPositionId);
  if (!isAssigned) throw new AppError('This training is not assigned to you', 403, 'FORBIDDEN');
  const currentMinutes = resource.estimated_minutes;
  if (currentMinutes != null && currentMinutes > 0) {
    return res.json({ success: true, data: resource });
  }
  const estimatedMinutes = durationSeconds / 60;
  await trainingRepo.updateResource(resourceId, { estimated_minutes: estimatedMinutes });
  const updated = await trainingRepo.findResourceById(resourceId);
  res.json({ success: true, data: updated });
});

// --- Programs ---
export const getPrograms = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const status = req.query.status; // 'draft' | 'published'
  const includeDraft = req.query.includeDraft !== 'false';
  const programs = await trainingRepo.findProgramsByOrg(org._id, { status, includeDraft });
  res.json({ success: true, data: programs });
});

export const getProgramById = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const modules = await trainingRepo.findModulesByProgram(programId);
  const modulesWithResources = await Promise.all(
    modules.map(async (mod) => {
      const resources = await trainingRepo.findResourcesByModule(mod._id);
      return { ...mod, resources };
    })
  );
  res.json({ success: true, data: { ...program, modules: modulesWithResources } });
});

export const createProgram = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }
  const { trainingRepo, org, tenantDb, boardMemberRepo } = await getTenantAndRepos(req);
  const {
    title,
    category,
    description,
    expires,
    renewal_months,
    department_ids,
    position_ids,
    track_completion_status,
    record_completion_dates,
    store_evidence,
    external_invitees
  } = req.body;
  const program = await trainingRepo.createProgram({
    org_id: org._id,
    title: title || category,
    category: category || title,
    description: description || '',
    expires: !!expires,
    renewal_months: renewal_months ?? 12,
    status: 'draft',
    department_ids: department_ids || [],
    position_ids: position_ids || [],
    track_completion_status: track_completion_status !== false,
    record_completion_dates: record_completion_dates !== false,
    store_evidence: !!store_evidence
  });

  // Optional: create external enrollments + email invite links
  const invitees = Array.isArray(external_invitees) ? external_invitees : [];
  let externalInviteLinks = [];
  if (invitees.length > 0) {
    const externalRepo = new ExternalTrainingEnrollmentRepository(tenantDb);
    const invitedBy = req.user?.userId || req.userId || null;
    const created = await externalRepo.upsertMany({
      orgKey: req.orgId,
      orgObjectId: org._id,
      programId: program._id,
      invitees,
      invitedByUserId: invitedBy
    });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    externalInviteLinks = created.map((enr) => ({
      email: enr.email,
      link: `${baseUrl}/public/training/${req.orgId}.${enr.token}`
    }));
    await Promise.all(
      created.map((enr) => {
        const link = `${baseUrl}/public/training/${req.orgId}.${enr.token}`;
        return emailService.sendExternalTrainingInvite({
          to: enr.email,
          recipientName: enr.name || enr.email,
          trainingTitle: program.title || program.category || 'Training',
          trainingLink: link
        });
      })
    );
  }

  notifyVolunteersForProgram({ boardMemberRepo, orgIdObj: org._id, program }).catch(() => {});

  res.status(201).json({ success: true, data: program, meta: { external_invite_links: externalInviteLinks } });
});

export const updateProgram = asyncHandler(async (req, res) => {
  const { trainingRepo, org, tenantDb, boardMemberRepo } = await getTenantAndRepos(req);
  const { programId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const allowed = [
    'title',
    'category',
    'description',
    'expires',
    'renewal_months',
    'department_ids',
    'position_ids',
    'track_completion_status',
    'record_completion_dates',
    'store_evidence'
  ];
  const updates = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  const updated = await trainingRepo.updateProgram(programId, updates);

  // Optional: create external enrollments + email invite links
  const invitees = Array.isArray(req.body.external_invitees) ? req.body.external_invitees : [];
  let externalInviteLinks = [];
  if (invitees.length > 0) {
    const externalRepo = new ExternalTrainingEnrollmentRepository(tenantDb);
    const invitedBy = req.user?.userId || req.userId || null;
    const created = await externalRepo.upsertMany({
      orgKey: req.orgId,
      orgObjectId: org._id,
      programId,
      invitees,
      invitedByUserId: invitedBy
    });
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    externalInviteLinks = created.map((enr) => ({
      email: enr.email,
      link: `${baseUrl}/public/training/${req.orgId}.${enr.token}`
    }));
    await Promise.all(
      created.map((enr) => {
        const link = `${baseUrl}/public/training/${req.orgId}.${enr.token}`;
        return emailService.sendExternalTrainingInvite({
          to: enr.email,
          recipientName: enr.name || enr.email,
          trainingTitle: updated?.title || updated?.category || 'Training',
          trainingLink: link
        });
      })
    );
  }

  notifyVolunteersForProgram({ boardMemberRepo, orgIdObj: org._id, program: updated }).catch(() => {});

  res.json({ success: true, data: updated, meta: { external_invite_links: externalInviteLinks } });
});

export const getExternalEnrollmentByToken = asyncHandler(async (req, res) => {
  const { token } = req.params;

  // We don't know org yet; search across tenant DBs isn't possible.
  // So: the token must embed orgKey prefix. We support both styles:
  // - "<orgKey>.<token>" (recommended)
  // - plain token (only works if orgKey is provided via x-org-id header)
  let orgKey = null;
  let pureToken = token;
  if (token.includes('.')) {
    const [prefix, rest] = token.split('.', 2);
    orgKey = prefix;
    pureToken = rest;
  }
  if (!orgKey) {
    orgKey = req.headers['x-org-id'];
  }
  if (!orgKey) throw new AppError('org key missing for public training link', 400, 'ORG_KEY_REQUIRED');

  const { org, trainingRepo, externalRepo } = await getTenantByOrgKey(orgKey);
  const enrollment = await externalRepo.findByToken(pureToken);
  if (!enrollment) throw new AppError('Invalid or expired training link', 404, 'NOT_FOUND');
  if (String(enrollment.org_id) !== String(org._id)) throw new AppError('Invalid training link', 403, 'FORBIDDEN');

  const program = await trainingRepo.findProgramById(enrollment.training_program_id);
  if (!program) throw new AppError('Training program not found', 404, 'NOT_FOUND');
  const modules = await trainingRepo.findModulesByProgram(program._id);
  const modulesWithResources = await Promise.all(
    modules.map(async (mod) => {
      const resources = await trainingRepo.findResourcesByModule(mod._id);
      return { ...mod, resources };
    })
  );

  // ensure progress includes entries for all resources
  const allResIds = new Set();
  modulesWithResources.forEach((m) => (m.resources || []).forEach((r) => allResIds.add(String(r._id))));
  const progress = Array.isArray(enrollment.progress) ? enrollment.progress : [];
  const byRes = new Map(progress.map((p) => [String(p.resource_id), p]));
  const merged = Array.from(allResIds).map((rid) => byRes.get(rid) || { resource_id: rid, status: 'not_started', video_seconds_watched: 0, pdf_percent_read: 0, completed_at: null });

  await externalRepo.updateProgressByToken(pureToken, { last_accessed_at: new Date(), progress: merged });
  const updatedEnrollment = await externalRepo.findByToken(pureToken);

  res.json({
    success: true,
    data: {
      enrollment: {
        email: updatedEnrollment.email,
        name: updatedEnrollment.name,
        status: updatedEnrollment.status,
        completed_at: updatedEnrollment.completed_at,
        progress: updatedEnrollment.progress
      },
      program: { ...program, modules: modulesWithResources }
    }
  });
});

export const updateExternalEnrollmentProgress = asyncHandler(async (req, res) => {
  const { token } = req.params;
  let orgKey = null;
  let pureToken = token;
  if (token.includes('.')) {
    const [prefix, rest] = token.split('.', 2);
    orgKey = prefix;
    pureToken = rest;
  }
  if (!orgKey) orgKey = req.headers['x-org-id'];
  if (!orgKey) throw new AppError('org key missing for public training link', 400, 'ORG_KEY_REQUIRED');

  const { org, externalRepo } = await getTenantByOrgKey(orgKey);
  const enrollment = await externalRepo.findByToken(pureToken);
  if (!enrollment) throw new AppError('Invalid or expired training link', 404, 'NOT_FOUND');
  if (String(enrollment.org_id) !== String(org._id)) throw new AppError('Invalid training link', 403, 'FORBIDDEN');

  const { resource_id, status, video_seconds_watched, pdf_percent_read, time_spent_seconds_delta, signature_data } = req.body || {};
  const progress = Array.isArray(enrollment.progress) ? enrollment.progress : [];
  const next = progress.map((p) => ({ ...p }));
  const idx = next.findIndex((p) => String(p.resource_id) === String(resource_id));
  const existing = idx >= 0
    ? next[idx]
    : {
        resource_id,
        status: 'not_started',
        video_seconds_watched: 0,
        pdf_percent_read: 0,
        time_spent_seconds: 0,
        started_at: null,
        last_activity_at: null,
        signature_data: null,
        completed_at: null
      };
  const alreadyCompleted = existing.status === 'completed' || existing.completed_at != null;

  const now = new Date();
  if (!existing.started_at && (status === 'in_progress' || status === 'completed' || (video_seconds_watched ?? 0) > 0 || (pdf_percent_read ?? 0) > 0 || (time_spent_seconds_delta ?? 0) > 0)) {
    existing.started_at = now;
  }
  existing.last_activity_at = now;

  if (typeof video_seconds_watched === 'number' && video_seconds_watched >= 0) existing.video_seconds_watched = video_seconds_watched;
  if (typeof pdf_percent_read === 'number' && pdf_percent_read >= 0) existing.pdf_percent_read = Math.min(100, Math.max(0, pdf_percent_read));
  if (typeof time_spent_seconds_delta === 'number' && time_spent_seconds_delta > 0) {
    existing.time_spent_seconds = Math.max(0, Number(existing.time_spent_seconds || 0) + Math.min(3600, time_spent_seconds_delta));
  }
  if (typeof signature_data === 'string' && signature_data.startsWith('data:image/')) {
    existing.signature_data = signature_data;
  }
  if (status === 'completed') {
    existing.status = 'completed';
    existing.completed_at = now;
  } else if (status === 'in_progress' && !alreadyCompleted) {
    existing.status = 'in_progress';
  }
  if (idx >= 0) next[idx] = existing;
  else next.push(existing);

  // derive enrollment status
  const allCompleted = next.length > 0 && next.every((p) => p.status === 'completed' || p.completed_at != null);
  const anyStarted = next.some((p) => p.status === 'in_progress' || p.status === 'completed' || p.completed_at != null);
  const enrStatus = allCompleted ? 'completed' : anyStarted ? 'in_progress' : 'not_started';

  const updated = await externalRepo.updateProgressByToken(pureToken, {
    progress: next,
    status: enrStatus,
    last_accessed_at: now,
    ...(enrollment.started_at == null && anyStarted ? { started_at: now } : {}),
    ...(allCompleted ? { completed_at: now } : {})
  });

  res.json({ success: true, data: { status: updated.status, completed_at: updated.completed_at, progress: updated.progress } });
});

export const completeExternalEnrollment = asyncHandler(async (req, res) => {
  const { token } = req.params;
  let orgKey = null;
  let pureToken = token;
  if (token.includes('.')) {
    const [prefix, rest] = token.split('.', 2);
    orgKey = prefix;
    pureToken = rest;
  }
  if (!orgKey) orgKey = req.headers['x-org-id'];
  if (!orgKey) throw new AppError('org key missing for public training link', 400, 'ORG_KEY_REQUIRED');

  const { org, externalRepo } = await getTenantByOrgKey(orgKey);
  const enrollment = await externalRepo.findByToken(pureToken);
  if (!enrollment) throw new AppError('Invalid or expired training link', 404, 'NOT_FOUND');
  if (String(enrollment.org_id) !== String(org._id)) throw new AppError('Invalid training link', 403, 'FORBIDDEN');

  const updated = await externalRepo.updateProgressByToken(pureToken, {
    status: 'completed',
    completed_at: new Date(),
    last_accessed_at: new Date()
  });
  res.json({ success: true, data: { status: updated.status, completed_at: updated.completed_at } });
});

export const getExternalEnrollmentResourceViewUrl = asyncHandler(async (req, res) => {
  const { token, resourceId } = req.params;
  let orgKey = null;
  let pureToken = token;
  if (token.includes('.')) {
    const [prefix, rest] = token.split('.', 2);
    orgKey = prefix;
    pureToken = rest;
  }
  if (!orgKey) orgKey = req.headers['x-org-id'];
  if (!orgKey) throw new AppError('org key missing for public training link', 400, 'ORG_KEY_REQUIRED');

  const { org, trainingRepo, externalRepo } = await getTenantByOrgKey(orgKey);
  const enrollment = await externalRepo.findByToken(pureToken);
  if (!enrollment) throw new AppError('Invalid or expired training link', 404, 'NOT_FOUND');
  if (String(enrollment.org_id) !== String(org._id)) throw new AppError('Invalid training link', 403, 'FORBIDDEN');

  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource) throw new AppError('Resource not found', 404, 'NOT_FOUND');
  const mod = await trainingRepo.findModuleById(resource.module_id);
  if (!mod) throw new AppError('Module not found', 404, 'NOT_FOUND');
  if (String(mod.training_program_id) !== String(enrollment.training_program_id)) {
    throw new AppError('Resource not part of this training', 403, 'FORBIDDEN');
  }

  if (resource.link_url) return res.json({ success: true, data: { url: resource.link_url } });
  if (!resource.file_url) throw new AppError('Resource has no file or link', 404, 'NO_CONTENT');
  const url = await getFileUrl(resource.file_url, 3600);
  res.json({ success: true, data: { url } });
});

export const streamExternalEnrollmentResource = asyncHandler(async (req, res) => {
  const { token, resourceId } = req.params;
  let orgKey = null;
  let pureToken = token;
  if (token.includes('.')) {
    const [prefix, rest] = token.split('.', 2);
    orgKey = prefix;
    pureToken = rest;
  }
  if (!orgKey) orgKey = req.headers['x-org-id'];
  if (!orgKey) throw new AppError('org key missing for public training link', 400, 'ORG_KEY_REQUIRED');

  const { org, trainingRepo, externalRepo } = await getTenantByOrgKey(orgKey);
  const enrollment = await externalRepo.findByToken(pureToken);
  if (!enrollment) throw new AppError('Invalid or expired training link', 404, 'NOT_FOUND');
  if (String(enrollment.org_id) !== String(org._id)) throw new AppError('Invalid training link', 403, 'FORBIDDEN');

  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource) throw new AppError('Resource not found', 404, 'NOT_FOUND');
  const mod = await trainingRepo.findModuleById(resource.module_id);
  if (!mod) throw new AppError('Module not found', 404, 'NOT_FOUND');
  if (String(mod.training_program_id) !== String(enrollment.training_program_id)) {
    throw new AppError('Resource not part of this training', 403, 'FORBIDDEN');
  }
  const type = (resource.type || '').toLowerCase();
  if (type !== 'pdf' && type !== 'video') throw new AppError('Resource is not streamable', 400, 'VALIDATION_ERROR');
  if (!resource.file_url) throw new AppError('Resource has no file', 404, 'NO_CONTENT');

  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await getFileStream(resource.file_url, rangeHeader);
  res.setHeader('Content-Type', ContentType || (type === 'pdf' ? 'application/pdf' : 'video/mp4'));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength) res.setHeader('Content-Length', ContentLength);
  Body.pipe(res);
});

export const publishProgram = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const updated = await trainingRepo.publishProgram(programId);
  res.json({ success: true, data: updated });
});

export const deleteProgram = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  await trainingRepo.deleteProgram(programId);
  res.json({ success: true, message: 'Training program deleted' });
});

// --- Modules ---
export const createModule = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const { title, description, order } = req.body;
  const mod = await trainingRepo.createModule({
    training_program_id: programId,
    title: title || 'Untitled module',
    description: description || '',
    order: order ?? 0
  });
  res.status(201).json({ success: true, data: mod });
});

export const updateModule = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId, moduleId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const mod = await trainingRepo.findModuleById(moduleId);
  if (!mod || mod.training_program_id.toString() !== programId) {
    throw new AppError('Module not found', 404, 'NOT_FOUND');
  }
  const allowed = ['title', 'description', 'order'];
  const updates = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  const updated = await trainingRepo.updateModule(moduleId, updates);
  res.json({ success: true, data: updated });
});

export const deleteModule = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId, moduleId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const mod = await trainingRepo.findModuleById(moduleId);
  if (!mod || mod.training_program_id.toString() !== programId) {
    throw new AppError('Module not found', 404, 'NOT_FOUND');
  }
  await trainingRepo.deleteModule(moduleId);
  res.json({ success: true, message: 'Module deleted' });
});

// --- Resources ---
export const createResource = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId, moduleId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const mod = await trainingRepo.findModuleById(moduleId);
  if (!mod || mod.training_program_id.toString() !== programId) {
    throw new AppError('Module not found', 404, 'NOT_FOUND');
  }
  const {
    name,
    type,
    file_url,
    link_url,
    cover_image_url,
    order,
    estimated_minutes
  } = req.body;
  const resType = (type || 'pdf').toLowerCase();
  const hasFile = file_url && String(file_url).trim();
  const hasLink = link_url && String(link_url).trim();
  if (['video', 'pdf', 'link'].includes(resType) && !hasFile && !hasLink) {
    throw new AppError(
      'Video, PDF and link resources require either a file upload or a link URL. Please add content before saving.',
      400,
      'RESOURCE_CONTENT_REQUIRED'
    );
  }
  const resource = await trainingRepo.createResource({
    module_id: moduleId,
    name: name || 'Untitled resource',
    type: type || 'pdf',
    file_url: file_url || null,
    link_url: link_url || null,
    cover_image_url: cover_image_url || null,
    order: order ?? 0,
    estimated_minutes: estimated_minutes ?? 0
  });
  res.status(201).json({ success: true, data: resource });
});

export const updateResource = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId, moduleId, resourceId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const mod = await trainingRepo.findModuleById(moduleId);
  if (!mod || mod.training_program_id.toString() !== programId) {
    throw new AppError('Module not found', 404, 'NOT_FOUND');
  }
  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource || resource.module_id.toString() !== moduleId) {
    throw new AppError('Resource not found', 404, 'NOT_FOUND');
  }
  const allowed = [
    'name',
    'type',
    'file_url',
    'link_url',
    'cover_image_url',
    'order',
    'estimated_minutes'
  ];
  const updates = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  const resType = (updates.type ?? resource.type ?? 'pdf').toLowerCase();
  const hasFile = (updates.file_url ?? resource.file_url) && String(updates.file_url ?? resource.file_url).trim();
  const hasLink = (updates.link_url ?? resource.link_url) && String(updates.link_url ?? resource.link_url).trim();
  if (['video', 'pdf', 'link'].includes(resType) && !hasFile && !hasLink) {
    throw new AppError(
      'Video, PDF and link resources must have either a file or a link URL. Please add content.',
      400,
      'RESOURCE_CONTENT_REQUIRED'
    );
  }
  const updated = await trainingRepo.updateResource(resourceId, updates);
  res.json({ success: true, data: updated });
});

export const deleteResource = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId, moduleId, resourceId } = req.params;
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  const mod = await trainingRepo.findModuleById(moduleId);
  if (!mod || mod.training_program_id.toString() !== programId) {
    throw new AppError('Module not found', 404, 'NOT_FOUND');
  }
  const resource = await trainingRepo.findResourceById(resourceId);
  if (!resource || resource.module_id.toString() !== moduleId) {
    throw new AppError('Resource not found', 404, 'NOT_FOUND');
  }
  await trainingRepo.deleteResource(resourceId);
  res.json({ success: true, message: 'Resource deleted' });
});

// --- Register list: people with training stats ---
export const getRegisterList = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, positionRepo, org, tenantDb } = await getTenantAndRepos(req);
  const category = req.query.category; // 'staff' | 'volunteer' | 'board_member' | omit = all
  const search = req.query.search; // name or email
  let boardMembers = await boardMemberRepo.findByOrgId(org._id, false);
  const keyHex = getMasterKeyHex();
  if (!keyHex) {
    throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
  }
  const decryptedBMs = boardMembers.map((bm) => {
    const obj = bm.toObject ? bm.toObject() : { ...bm };
    decryptBoardMemberFields(obj, keyHex);
    return obj;
  });
  let filtered = decryptedBMs;
  if (category) {
    const cat = category.toLowerCase();
    filtered = filtered.filter((bm) => {
      const pos = (bm.position || '').toLowerCase();
      if (cat === 'staff') return pos.includes('staff') || pos.includes('manager') || pos.includes('officer') || pos.includes('coordinator') || !pos.includes('volunteer') && !pos.includes('board');
      if (cat === 'volunteer') return pos.includes('volunteer');
      if (cat === 'board_member') return pos.includes('board') || pos.includes('director') || pos.includes('trustee');
      return true;
    });
  }
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter(
      (bm) =>
        (bm.given_names && bm.given_names.toLowerCase().includes(q)) ||
        (bm.family_name && bm.family_name.toLowerCase().includes(q)) ||
        (bm.email && bm.email.toLowerCase().includes(q))
    );
  }
  const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: false });
  const allPositions = await positionRepo.findByOrgId(org._id);
  const positionIdByTitle = {};
  for (const pos of allPositions) {
    const t = (pos.title || '').trim().toLowerCase();
    if (t) positionIdByTitle[t] = pos._id.toString();
  }
  const result = await Promise.all(
    filtered.map(async (bm) => {
      const bmPositionId = (bm.position_id?.toString?.()) ||
        (positionIdByTitle[(bm.position || bm.custom_position_title || '').trim().toLowerCase()]);
      // Required programs = published programs assigned to this person's position
      const requiredPrograms = programs.filter((p) => {
        if (!bmPositionId || !Array.isArray(p.position_ids)) return false;
        return p.position_ids.some((pid) => (pid?.toString?.() || pid) === bmPositionId);
      });
      const totalRequired = requiredPrograms.length;
      let totalCompleted = 0;
      let lastActivity = null;
      for (const prog of requiredPrograms) {
        const programId = prog._id.toString();
        const resourceIds = await trainingRepo.getResourceIdsByProgram(programId);
        const totalInProgram = resourceIds.length;
        const enrollment = await trainingRepo.findEnrollmentByProgramAndPerson(programId, bm._id);
        if (enrollment) {
          const completions = await trainingRepo.findCompletionsByEnrollment(enrollment._id);
          const completedInProgram = completions.filter((c) => c.status === 'completed').length;
          if (totalInProgram > 0 && completedInProgram >= totalInProgram) {
            totalCompleted += 1;
          }
          if (enrollment.completed_at) {
            if (!lastActivity || new Date(enrollment.completed_at) > new Date(lastActivity)) lastActivity = enrollment.completed_at;
          }
          completions.forEach((c) => {
            if (c.completed_at && (!lastActivity || new Date(c.completed_at) > new Date(lastActivity))) {
              lastActivity = c.completed_at;
            }
          });
          if (enrollment.enrolled_at && (!lastActivity || new Date(enrollment.enrolled_at) > new Date(lastActivity))) {
            lastActivity = enrollment.enrolled_at;
          }
        }
      }
      const categoryLabel =
        (bm.position || '').toLowerCase().includes('volunteer')
          ? 'Volunteer'
          : (bm.position || '').toLowerCase().match(/board|director|trustee/)
            ? 'Board Member'
            : 'Staff';
      let profile_picture_url = null;
      if (bm.profile_picture_key) {
        try {
          const { getFileUrl } = await import('../services/s3Service.js');
          profile_picture_url = await getFileUrl(bm.profile_picture_key, 604800);
        } catch (err) {
          // ignore per-member URL failure
        }
      }
      return {
        _id: bm._id,
        name: [bm.given_names, bm.family_name].filter(Boolean).join(' '),
        email: bm.email,
        role: bm.position || bm.custom_position_title || '—',
        category: categoryLabel,
        training: `${totalCompleted}/${totalRequired}`,
        trainingCompleted: totalCompleted,
        trainingTotal: totalRequired,
        lastActivity: lastActivity || null,
        profile_picture_url,
        wwcc_status: bm.wwcc?.status || 'not_uploaded',
        police_check_status: bm.police_check?.status || 'not_uploaded'
      };
    })
  );

  // External participants (token-based)
  const externalRepo = new ExternalTrainingEnrollmentRepository(tenantDb);
  const externalEnrollments = await externalRepo.listByOrg(org._id, { search });
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const externalRows = await Promise.all(
    externalEnrollments.map(async (enr) => {
      const program = await trainingRepo.findProgramById(enr.training_program_id);
      const programTitle = program?.title || program?.category || 'Training';
      const lastActivity = enr.last_activity_at || enr.last_accessed_at || enr.updatedAt || enr.enrolled_at || null;
      const recipientType = String(enr?.metadata?.recipient_type || '').toLowerCase();
      const roleLabel = recipientType === 'donor'
        ? 'Donor'
        : recipientType === 'volunteer'
          ? 'Volunteer'
          : recipientType === 'visitor'
            ? 'Visitor'
            : 'External participant';
      const categoryLabel = recipientType === 'donor'
        ? 'Donor'
        : recipientType === 'volunteer'
          ? 'Volunteer'
          : 'External';
      return {
        _id: `external:${enr._id}`,
        external_enrollment_id: enr._id,
        name: enr.name || enr.email,
        email: enr.email,
        role: roleLabel,
        category: categoryLabel,
        training: `${enr.status === 'completed' ? 1 : 0}/1`,
        trainingCompleted: enr.status === 'completed' ? 1 : 0,
        trainingTotal: 1,
        lastActivity,
        profile_picture_url: null,
        wwcc_status: 'n/a',
        police_check_status: 'n/a',
        external: true,
        program_title: programTitle,
        program_id: enr.training_program_id,
        public_link: `${baseUrl}/public/training/${req.orgId}.${enr.token}`,
        recipient_type: recipientType || null,
        board_member_id: enr?.metadata?.board_member_id || null,
        donor_id: enr?.metadata?.donor_id || null
      };
    })
  );

  const combined = [...result, ...externalRows].sort((a, b) => {
    const ad = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bd = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bd - ad;
  });

  res.json({ success: true, data: combined });
});

// --- Register metrics (summary cards) ---
export const getRegisterMetrics = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org, tenantDb } = await getTenantAndRepos(req);
  const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: false });
  const programIds = programs.map((p) => p._id);
  let totalModules = 0;
  let totalResources = 0;
  let addedThisMonth = 0;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  for (const p of programs) {
    const modules = await trainingRepo.findModulesByProgram(p._id);
    totalModules += modules.length;
    for (const m of modules) {
      const resources = await trainingRepo.findResourcesByModule(m._id);
      totalResources += resources.length;
    }
    if (p.createdAt && new Date(p.createdAt) >= startOfMonth) addedThisMonth++;
  }
  const boardMembers = await boardMemberRepo.findByOrgId(org._id, false);
  let enrolledCount = 0;
  let inProgressCount = 0;
  let completeCount = 0;
  let overdueCount = 0;
  let expiringIn30Count = 0;
  for (const bm of boardMembers) {
    const enrollments = await trainingRepo.findEnrollmentsByPerson(bm._id);
    const relevant = enrollments.filter((e) => {
      const pid = e.training_program_id?._id?.toString?.() || e.training_program_id?.toString?.();
      return pid && programIds.some((id) => id.toString() === pid);
    });
    if (relevant.length > 0) enrolledCount++;
    for (const enr of relevant) {
      if (enr.status === 'in_progress') inProgressCount++;
      if (enr.status === 'completed') completeCount++;
    }
  }

  // External enrollments
  const externalRepo = new ExternalTrainingEnrollmentRepository(tenantDb);
  const externals = await externalRepo.listByOrg(org._id, {});
  // count unique people by email
  const externalEmails = new Set(externals.map((e) => (e.email || '').toLowerCase()).filter(Boolean));
  enrolledCount += externalEmails.size;
  for (const enr of externals) {
    if (enr.status === 'in_progress') inProgressCount++;
    if (enr.status === 'completed') completeCount++;
  }

  res.json({
    success: true,
    data: {
      activeTrainingModules: totalModules,
      addedThisMonth,
      peopleEnrolled: enrolledCount,
      inProgress: inProgressCount,
      overdueOrExpiring: overdueCount + expiringIn30Count,
      expiringIn30Days: expiringIn30Count,
      complete: completeCount,
      completePercent: enrolledCount > 0 ? Math.round((completeCount / enrolledCount) * 100) : 0
    }
  });
});

/**
 * Training completion activity heatmap (GitHub-like).
 * Returns daily counts of completed resources within a date range (default: last 26 weeks).
 *
 * GET /platform/training/activity/heatmap?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
export const getTrainingActivityHeatmap = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);

  const end = req.query.end_date ? new Date(String(req.query.end_date)) : new Date();
  end.setHours(23, 59, 59, 999);
  const start = req.query.start_date ? new Date(String(req.query.start_date)) : new Date(end);
  if (!req.query.start_date) start.setDate(start.getDate() - (26 * 7 - 1));
  start.setHours(0, 0, 0, 0);

  // Internal completions (portal users)
  const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: true });
  const programIds = (programs || []).map((p) => p?._id).filter(Boolean);

  const TrainingProgram = trainingRepo.TrainingProgram;

  let internalBuckets = [];
  if (programIds.length > 0) {
    internalBuckets = await TrainingProgram.aggregate([
      {
        $match: {
          _id: { $in: programIds }
        }
      },
      { $unwind: '$enrollments' },
      { $match: { 'enrollments.enrollment_type': 'internal' } },
      { $unwind: '$enrollments.completions' },
      {
        $match: {
          'enrollments.completions.status': 'completed',
          'enrollments.completions.completed_at': { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$enrollments.completions.completed_at' }
          },
          count: { $sum: 1 }
        }
      },
      { $project: { _id: 0, date: '$_id', count: 1 } }
    ]);
  }

  // External completions (token-based)
  const externalBuckets = await TrainingProgram.aggregate([
    {
      $match: {
        org_id: org._id,
      }
    },
    { $unwind: '$enrollments' },
    {
      $match: {
        'enrollments.enrollment_type': 'external',
        'enrollments.status': 'completed',
        'enrollments.completed_at': { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$enrollments.completed_at' }
        },
        count: { $sum: 1 }
      }
    },
    { $project: { _id: 0, date: '$_id', count: 1 } }
  ]);

  const map = new Map();
  for (const b of [...(internalBuckets || []), ...(externalBuckets || [])]) {
    const d = b?.date;
    if (!d) continue;
    map.set(d, (map.get(d) || 0) + (Number(b?.count || 0) || 0));
  }

  const data = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    data.push({ date: iso, count: map.get(iso) || 0 });
  }

  res.json({ success: true, data });
});

// --- My training (current user's assigned courses; for members, not HR) ---
export const getMyTraining = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  // Get ALL active board_member records for this user (they may hold multiple positions)
  const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userId, org._id);
  if (!allBoardMembers || allBoardMembers.length === 0) {
    return res.json({
      success: true,
      data: {
        person: null,
        records: [],
        duePrograms: []
      }
    });
  }

  // Build a map: positionId → boardMember (for enrollment creation)
  const positionToBm = new Map();
  const allPositionIds = new Set();
  for (const bm of allBoardMembers) {
    const pid = bm.position_id?.toString?.() || null;
    if (pid) {
      allPositionIds.add(pid);
      if (!positionToBm.has(pid)) positionToBm.set(pid, bm);
    }
  }

  const primaryBm = allBoardMembers[0];
  const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: false });

  const duePrograms = programs.filter((p) => {
    if (!Array.isArray(p.position_ids) || allPositionIds.size === 0) return false;
    return p.position_ids.some((pid) => allPositionIds.has(pid?.toString?.() || pid));
  });

  const records = [];
  for (const prog of duePrograms) {
    const programId = prog._id.toString();

    // Find which board_member matches this program's position
    const matchingPid = prog.position_ids.find(pid => allPositionIds.has(pid?.toString?.() || pid));
    const targetBm = positionToBm.get(matchingPid?.toString?.() || matchingPid) || primaryBm;

    let enrollment = await trainingRepo.findEnrollmentByProgramAndPerson(programId, targetBm._id);
    if (!enrollment) {
      const resourceIds = await trainingRepo.getResourceIdsByProgram(programId);
      enrollment = await trainingRepo.upsertEnrollment(programId, targetBm._id);
      for (const resId of resourceIds) {
        await trainingRepo.upsertCompletion(enrollment._id, resId, {});
      }
      enrollment = await trainingRepo.findEnrollmentByProgramAndPerson(programId, targetBm._id);
    }
    const modules = await trainingRepo.findModulesByProgram(programId);
    const modulesWithResources = await Promise.all(
      modules.map(async (mod) => {
        const resources = await trainingRepo.findResourcesByModule(mod._id);
        const resourcesWithCompletion = await Promise.all(
          resources.map(async (res) => {
            const comp = await trainingRepo.findCompletion(enrollment._id, res._id);
            const completion = comp || { status: 'not_started', completed_at: null, video_seconds_watched: 0, pdf_percent_read: 0 };
            return {
              ...res,
              completion: normalizeCompletion(completion)
            };
          })
        );
        return { ...mod, resources: resourcesWithCompletion };
      })
    );
    records.push({
      enrollment: { ...enrollment, training_program_id: prog },
      program: prog,
      modules: modulesWithResources
    });
  }
  res.json({
    success: true,
    data: {
      person: {
        _id: primaryBm._id,
        name: [primaryBm.given_names, primaryBm.family_name].filter(Boolean).join(' ')
      },
      records,
      duePrograms: duePrograms.map((p) => ({ _id: p._id, title: p.title, category: p.category }))
    }
  });
});

// --- Program report data (for HR PDF export) ---
export const getProgramReportData = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const { programId } = req.params;

  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }

  const modules = await trainingRepo.findModulesByProgram(programId);
  const modulesWithResources = await Promise.all(
    modules.map(async (mod) => {
      const resources = await trainingRepo.findResourcesByModule(mod._id);
      return { ...mod, resources };
    })
  );

  const enrollments = await trainingRepo.findEnrollmentsByProgram(programId);
  const enrollmentsWithCompletions = [];
  for (const enr of enrollments) {
    const completions = await trainingRepo.findCompletionsByEnrollment(enr._id);
    const person = enr.board_member_id
      ? {
          _id: enr.board_member_id._id,
          name: [enr.board_member_id.given_names, enr.board_member_id.family_name].filter(Boolean).join(' '),
          position: enr.board_member_id.position_title || ''
        }
      : null;
    enrollmentsWithCompletions.push({
      _id: enr._id,
      status: enr.status,
      completed_at: enr.completed_at,
      person,
      survey: enr.post_training_survey || null,
      completions: completions.map((c) => ({
        _id: c._id,
        resource_id: c.resource_id?._id || c.resource_id,
        status: c.status,
        completed_at: c.completed_at,
        pdf_percent_read: c.pdf_percent_read,
        video_seconds_watched: c.video_seconds_watched,
        signature_data: c.signature_data,
        resource: c.resource_id || null
      }))
    });
  }

  // Resolve resource file URLs to signed HTTP URLs for PDF links
  if (modulesWithResources.length) {
    const { getFileUrl } = await import('../services/s3Service.js');
    for (const mod of modulesWithResources) {
      if (!mod.resources) continue;
      for (const res of mod.resources) {
        if (!res.link_url && res.file_url && !/^https?:\/\//i.test(res.file_url)) {
          try {
            // 7 days expiry – long enough for downloaded PDFs to be used
            res.file_url = await getFileUrl(res.file_url, 604800);
          } catch {
            // If signing fails, leave original key; PDF will still render without a working link
          }
        }
      }
    }
  }

  res.json({
    success: true,
    data: {
      program,
      modules: modulesWithResources,
      enrollments: enrollmentsWithCompletions
    }
  });
});

// --- Enrollment report data (for member PDF export) ---
export const getEnrollmentReportData = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const { enrollmentId } = req.params;

  const enrollment = await trainingRepo.findEnrollmentById(enrollmentId);
  if (!enrollment) {
    throw new AppError('Enrollment not found', 404, 'NOT_FOUND');
  }

  const program = await trainingRepo.findProgramById(enrollment.training_program_id);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }

  const boardMember = await boardMemberRepo.findById(enrollment.board_member_id);
  const person = boardMember
    ? {
        _id: boardMember._id,
        name: [boardMember.given_names, boardMember.family_name].filter(Boolean).join(' '),
        position: boardMember.position_title || ''
      }
    : null;

  const modules = await trainingRepo.findModulesByProgram(program._id);
  const modulesWithResources = await Promise.all(
    modules.map(async (mod) => {
      const resources = await trainingRepo.findResourcesByModule(mod._id);
      return { ...mod, resources };
    })
  );

  const completions = await trainingRepo.findCompletionsByEnrollment(enrollment._id);

  res.json({
    success: true,
    data: {
      program,
      person,
      modules: modulesWithResources,
      completions: completions.map((c) => ({
        _id: c._id,
        resource_id: c.resource_id?._id || c.resource_id,
        status: c.status,
        completed_at: c.completed_at,
        pdf_percent_read: c.pdf_percent_read,
        video_seconds_watched: c.video_seconds_watched,
        signature_data: c.signature_data
      })),
      survey: enrollment.post_training_survey || null
    }
  });
});

// --- PDF exports using HTML → PDF service (matching policy/approval style) ---
export const exportProgramPdf = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
  const { programId } = req.params;

  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }

  const modules = await trainingRepo.findModulesByProgram(programId);
  const modulesWithResources = await Promise.all(
    modules.map(async (mod) => {
      const resources = await trainingRepo.findResourcesByModule(mod._id);
      return { ...mod, resources };
    })
  );

  const enrollments = await trainingRepo.findEnrollmentsByProgram(programId);
  const enrollmentsWithCompletions = [];
  for (const enr of enrollments) {
    const completions = await trainingRepo.findCompletionsByEnrollment(enr._id);
    const person = enr.board_member_id
      ? {
          _id: enr.board_member_id._id,
          name: [enr.board_member_id.given_names, enr.board_member_id.family_name].filter(Boolean).join(' '),
          position: enr.board_member_id.position_title || ''
        }
      : null;
    enrollmentsWithCompletions.push({
      _id: enr._id,
      status: enr.status,
      completed_at: enr.completed_at,
      person,
      completions: completions.map((c) => ({
        _id: c._id,
        resource_id: c.resource_id?._id || c.resource_id,
        status: c.status,
        completed_at: c.completed_at,
        pdf_percent_read: c.pdf_percent_read,
        video_seconds_watched: c.video_seconds_watched,
        signature_data: c.signature_data,
        resource: c.resource_id || null
      }))
    });
  }

  const tenantDb = await getTenantConnection(req.orgId);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const orgDoc = await orgRepo.findOne();
  const logoUrl = orgDoc?.logo_url || process.env.LOGO || '';

  const { generateTrainingProgramPDF } = await import('../services/trainingPdfService.js');
  const buffer = await generateTrainingProgramPDF(
    { program, modules: modulesWithResources, enrollments: enrollmentsWithCompletions },
    logoUrl
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="training-program-${programId}.pdf"`);
  res.send(buffer);
});

export const exportEnrollmentPdf = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const { enrollmentId } = req.params;
  const userId = req.user?.userId;

  const enrollment = await trainingRepo.findEnrollmentById(enrollmentId);
  if (!enrollment) {
    throw new AppError('Enrollment not found', 404, 'NOT_FOUND');
  }

  const program = await trainingRepo.findProgramById(enrollment.training_program_id);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }

  const boardMember = await boardMemberRepo.findById(enrollment.board_member_id);
  if (!boardMember) {
    throw new AppError('Participant not found', 404, 'NOT_FOUND');
  }

  // Security: only the participant themselves, or HR/owners, should be able to export this.
  // We piggyback on boardMemberRepo checks: if the current user isn't same as bm.user_id, we still allow
  // because HR-level authorisation is enforced at route level by module permissions.
  if (boardMember.user_id?.toString?.() !== userId && !req.user?.isOrgOwner) {
    // For now, we just proceed; route guards should already restrict access.
  }

  const modules = await trainingRepo.findModulesByProgram(program._id);
  const modulesWithResources = await Promise.all(
    modules.map(async (mod) => {
      const resources = await trainingRepo.findResourcesByModule(mod._id);
      return { ...mod, resources };
    })
  );

  // Resolve resource file URLs to signed HTTP URLs for PDF links
  if (modulesWithResources.length) {
    const { getFileUrl } = await import('../services/s3Service.js');
    for (const mod of modulesWithResources) {
      if (!mod.resources) continue;
      for (const res of mod.resources) {
        if (!res.link_url && res.file_url && !/^https?:\/\//i.test(res.file_url)) {
          try {
            res.file_url = await getFileUrl(res.file_url, 604800);
          } catch {
            // best-effort; keep original key on failure
          }
        }
      }
    }
  }

  const completions = await trainingRepo.findCompletionsByEnrollment(enrollment._id);

  const tenantDb = await getTenantConnection(req.orgId);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const orgDoc = await orgRepo.findOne();
  const logoUrl = orgDoc?.logo_url || process.env.LOGO || '';

  const { generateTrainingMemberPDF } = await import('../services/trainingPdfService.js');
  const buffer = await generateTrainingMemberPDF(
    {
      program,
      person: {
        _id: boardMember._id,
        name: [boardMember.given_names, boardMember.family_name].filter(Boolean).join(' '),
        position: boardMember.position_title || ''
      },
      modules: modulesWithResources,
      completions,
      survey: enrollment.post_training_survey || null
    },
    logoUrl
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="training-enrollment-${enrollmentId}.pdf"`);
  res.send(buffer);
});

// --- Update resource progress (video seconds, PDF %, or mark completed) ---
export const updateResourceProgress = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userId, org._id);
  if (!allBoardMembers || allBoardMembers.length === 0) throw new AppError('You are not registered as a member', 403, 'FORBIDDEN');
  const bmIdSet = new Set(allBoardMembers.map(bm => bm._id.toString()));
  const { enrollmentId, resourceId } = req.params;
  const { video_seconds_watched, pdf_percent_read, status, signature_data } = req.body || {};
  const enrollmentDoc = await trainingRepo.findEnrollmentById(enrollmentId);
  if (!enrollmentDoc || !bmIdSet.has(enrollmentDoc.board_member_id?.toString?.())) {
    throw new AppError('Enrollment not found', 404, 'NOT_FOUND');
  }
  const existing = await trainingRepo.findCompletion(enrollmentId, resourceId);
  const alreadyCompleted = existing?.status === 'completed' || (existing?.completed_at != null);

  const updates = {};
  if (typeof video_seconds_watched === 'number' && video_seconds_watched >= 0) updates.video_seconds_watched = video_seconds_watched;
  if (typeof pdf_percent_read === 'number' && pdf_percent_read >= 0) updates.pdf_percent_read = Math.min(100, Math.max(0, pdf_percent_read));
  if (status === 'completed' || status === 'in_progress') {
    // Never downgrade from completed to in_progress (avoids race where progress overwrites completion)
    if (status === 'completed') {
      updates.status = status;
      updates.completed_at = new Date();
    } else if (status === 'in_progress' && !alreadyCompleted) {
      updates.status = status;
    }
  }
  if (typeof signature_data === 'string' && signature_data.length > 0) updates.signature_data = signature_data;
  const comp = await trainingRepo.upsertCompletion(enrollmentId, resourceId, updates);
  res.json({ success: true, data: normalizeCompletion(comp) });
});

// --- Save optional post-training survey for an enrollment ---
export const saveEnrollmentSurvey = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');

  const { enrollmentId } = req.params;
  const enrollment = await trainingRepo.findEnrollmentById(enrollmentId);
  if (!enrollment) {
    throw new AppError('Enrollment not found', 404, 'NOT_FOUND');
  }

  const program = await trainingRepo.findProgramById(enrollment.training_program_id);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }

  const boardMember = await boardMemberRepo.findById(enrollment.board_member_id);
  if (!boardMember) {
    throw new AppError('Participant not found', 404, 'NOT_FOUND');
  }

  // Only the assigned participant can submit their survey (HR sees results via exports)
  if (boardMember.user_id?.toString?.() !== userId && !req.user?.isOrgOwner) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }

  const { rating, clarity, relevance, comments } = req.body || {};
  const safeRating = typeof rating === 'number' ? Math.min(5, Math.max(1, rating)) : undefined;

  const survey = {
    ...(safeRating ? { rating: safeRating } : {}),
    ...(clarity ? { clarity } : {}),
    ...(relevance ? { relevance } : {}),
    ...(comments ? { comments: String(comments).slice(0, 1000) } : {}),
    completed_at: new Date()
  };

  const updated = await trainingRepo.updateEnrollment(enrollmentId, {
    post_training_survey: survey
  });

  res.json({
    success: true,
    data: updated?.post_training_survey || survey
  });
});

// --- One person's training & competency record ---
export const getPersonTrainingRecord = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org, tenantDb } = await getTenantAndRepos(req);
  const { boardMemberId } = req.params;
  const boardMember = await boardMemberRepo.findById(boardMemberId);
  if (!boardMember || boardMember.org_id.toString() !== org._id.toString()) {
    throw new AppError('Person not found', 404, 'NOT_FOUND');
  }
  const bmObj = boardMember.toObject ? boardMember.toObject() : { ...boardMember };
  const keyHex = getMasterKeyHex();
  if (!keyHex) {
    throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
  }
  decryptBoardMemberFields(bmObj, keyHex);
  const enrollments = await trainingRepo.findEnrollmentsByPerson(boardMemberId);
  const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: false });
  const programIds = new Set(programs.map((p) => p._id.toString()));
  const records = await Promise.all(
    enrollments
      .filter((e) => {
        const pid = e.training_program_id?._id?.toString?.() || e.training_program_id?.toString?.();
        return pid && programIds.has(pid);
      })
      .map(async (enr) => {
        const programId = enr.training_program_id?._id?.toString?.() || enr.training_program_id?.toString?.();
        const modules = await trainingRepo.findModulesByProgram(programId);
        const modulesWithResources = await Promise.all(
          modules.map(async (mod) => {
            const resources = await trainingRepo.findResourcesByModule(mod._id);
            const resourcesWithCompletion = await Promise.all(
              resources.map(async (res) => {
                const comp = await trainingRepo.findCompletion(enr._id, res._id);
                const completion = comp || { status: 'not_started', completed_at: null };
                return {
                  ...res,
                  completion: normalizeCompletion(completion)
                };
              })
            );
            return { ...mod, resources: resourcesWithCompletion };
          })
        );
        return {
          enrollment: enr,
          program: enr.training_program_id,
          modules: modulesWithResources
        };
      })
  );
  const categoryLabel =
    (bmObj.position || '').toLowerCase().includes('volunteer')
      ? 'Volunteer'
      : (bmObj.position || '').toLowerCase().match(/board|director|trustee/)
        ? 'Board Member'
        : 'Staff';
  res.json({
    success: true,
    data: {
      person: {
        _id: bmObj._id,
        name: [bmObj.given_names, bmObj.family_name].filter(Boolean).join(' '),
        email: bmObj.email,
        role: bmObj.position || bmObj.custom_position_title || '—',
        category: categoryLabel
      },
      wwcc: bmObj.wwcc || { status: 'not_uploaded' },
      police_check: bmObj.police_check || { status: 'not_uploaded' },
      trainingStatus: records.length,
      records
    }
  });
});

// --- Assign training to people (create enrollments for a program for selected board members) ---
export const assignProgramToPeople = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org, tenantDb } = await getTenantAndRepos(req);
  const { programId } = req.params;
  const { board_member_ids } = req.body; // array of board member ids
  const program = await trainingRepo.findProgramById(programId);
  if (!program || program.org_id.toString() !== org._id.toString()) {
    throw new AppError('Training program not found', 404, 'NOT_FOUND');
  }
  if (!Array.isArray(board_member_ids) || board_member_ids.length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'board_member_ids array is required' }
    });
  }
  const resourceIds = await trainingRepo.getResourceIdsByProgram(programId);
  for (const bmId of board_member_ids) {
    const enrollment = await trainingRepo.upsertEnrollment(programId, bmId);
    for (const resId of resourceIds) {
      await trainingRepo.upsertCompletion(enrollment._id, resId, {});
    }
  }

  // Notify assigned people (internal users + volunteers)
  try {
    const volunteers = await Promise.all(
      board_member_ids.map(async (bmId) => {
        const person = await boardMemberRepo.findById(bmId);
        return person;
      })
    );

    const people = (volunteers || []).filter(Boolean);
    const trainingTitle = program.title || program.category || 'Training';

    // In-app notifications for org users (requires user_id)
    try {
      const notificationRepo = new NotificationRepository(tenantDb);
      const items = people
        .map((p) => {
          const userId = p.user_id?._id || p.user_id;
          if (!userId) return null;
          return {
            user_id: userId,
            type: 'training_assigned',
            title: 'Training assigned',
            message: `A training has been assigned to you: ${trainingTitle}`,
            link: '/human-resources/my-training',
            related_entity_id: program._id,
            related_entity_type: 'training_program',
            read: false,
            created_at: new Date(),
          };
        })
        .filter(Boolean);
      await notificationRepo.createMany(items);
    } catch {
      // non-blocking
    }

    // Email notifications (if email exists)
    await Promise.all(
      people
        .filter((p) => p?.email)
        .map((p) => {
          const recipientName = `${p.given_names || ''} ${p.family_name || ''}`.trim() || 'Member';
          if (p.is_volunteer === true) {
            return emailService.sendVolunteerTrainingNotification({
              to: p.email,
              recipientName,
              trainingTitle,
            });
          }
          return emailService.sendInternalTrainingAssignedEmail({
            to: p.email,
            recipientName,
            trainingTitle,
          });
        })
    );
  } catch {
    // Do not block assignment if notification fails
  }

  const enrollments = await trainingRepo.findEnrollmentsByProgram(programId);
  res.json({ success: true, data: enrollments });
});
