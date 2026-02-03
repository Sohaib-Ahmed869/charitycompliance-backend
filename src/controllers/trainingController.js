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
export const streamResourcePdf = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
  if (!boardMember) throw new AppError('You are not registered as a member', 403, 'FORBIDDEN');
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
  const bmPositionId = boardMember.position_id?.toString?.() || null;
  const isAssigned = bmPositionId && Array.isArray(program.position_ids) &&
    program.position_ids.some((pid) => (pid?.toString?.() || pid) === bmPositionId);
  if (!isAssigned) throw new AppError('This training is not assigned to you', 403, 'FORBIDDEN');
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
  const { trainingRepo, org } = await getTenantAndRepos(req);
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
    store_evidence
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
  res.status(201).json({ success: true, data: program });
});

export const updateProgram = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
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
  res.json({ success: true, data: updated });
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
        profile_picture_url
      };
    })
  );
  res.json({ success: true, data: result });
});

// --- Register metrics (summary cards) ---
export const getRegisterMetrics = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
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

// --- My training (current user's assigned courses; for members, not HR) ---
export const getMyTraining = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
  if (!boardMember) {
    return res.json({
      success: true,
      data: {
        person: null,
        records: [],
        duePrograms: []
      }
    });
  }
  const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: false });
  const bmPositionId = boardMember.position_id?.toString?.() || null;
  const duePrograms = programs.filter((p) => {
    if (!bmPositionId || !Array.isArray(p.position_ids)) return false;
    return p.position_ids.some((pid) => (pid?.toString?.() || pid) === bmPositionId);
  });
  const records = [];
  for (const prog of duePrograms) {
    const programId = prog._id.toString();
    let enrollment = await trainingRepo.findEnrollmentByProgramAndPerson(programId, boardMember._id);
    if (!enrollment) {
      const resourceIds = await trainingRepo.getResourceIdsByProgram(programId);
      enrollment = await trainingRepo.upsertEnrollment(programId, boardMember._id);
      for (const resId of resourceIds) {
        await trainingRepo.upsertCompletion(enrollment._id, resId, {});
      }
      enrollment = await trainingRepo.findEnrollmentByProgramAndPerson(programId, boardMember._id);
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
        _id: boardMember._id,
        name: [boardMember.given_names, boardMember.family_name].filter(Boolean).join(' ')
      },
      records,
      duePrograms: duePrograms.map((p) => ({ _id: p._id, title: p.title, category: p.category }))
    }
  });
});

// --- Update resource progress (video seconds, PDF %, or mark completed) ---
export const updateResourceProgress = asyncHandler(async (req, res) => {
  const { trainingRepo, boardMemberRepo, org } = await getTenantAndRepos(req);
  const userId = req.user?.userId;
  if (!userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
  if (!boardMember) throw new AppError('You are not registered as a member', 403, 'FORBIDDEN');
  const { enrollmentId, resourceId } = req.params;
  const { video_seconds_watched, pdf_percent_read, status, signature_data } = req.body || {};
  const enrollmentDoc = await trainingRepo.findEnrollmentById(enrollmentId);
  if (!enrollmentDoc || enrollmentDoc.board_member_id?.toString?.() !== boardMember._id.toString()) {
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
      trainingStatus: records.length,
      records
    }
  });
});

// --- Assign training to people (create enrollments for a program for selected board members) ---
export const assignProgramToPeople = asyncHandler(async (req, res) => {
  const { trainingRepo, org } = await getTenantAndRepos(req);
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
  const enrollments = await trainingRepo.findEnrollmentsByProgram(programId);
  res.json({ success: true, data: enrollments });
});
