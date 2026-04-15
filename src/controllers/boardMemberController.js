/**
 * Board Member Controller
 *
 * Handles HTTP requests for responsible people (board members)
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getTenantConnection } from '../db/connectionManager.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';
import emailService from '../services/emailService.js';
import { getFileUrl, uploadToS3 } from '../services/s3Service.js';
import { logInfo, logError } from '../utils/logger.js';
import { decryptBoardMemberFields, decryptBoardMemberList } from '../utils/decryptBoardMember.js';
import { createVolunteerActionToken } from '../services/volunteerActionTokenService.js';

const NORMALIZED_SUITABILITY_TYPES = new Set([
  'criminal_history_declaration',
  'bankruptcy_check',
  'disqualification_status',
  'conflict_of_interest',
  'fit_and_proper_check'
]);

const computeSuitabilityStatus = (suitability = {}) => {
  const items = Array.isArray(suitability?.items) ? suitability.items : [];
  const now = new Date();
  const hasExpiredItem = items.some((item) => item?.expires_at && new Date(item.expires_at) < now);
  if (hasExpiredItem) return 'expired';
  if (suitability?.next_review_date && new Date(suitability.next_review_date) < now) return 'expired';
  if (items.length > 0 && items.every((item) => item?.completed)) return 'verified';
  return 'pending';
};

export const getBoardMembers = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const includeInactive = req.query.includeInactive === 'true';
  const boardMembers = await boardMemberRepo.findByOrgId(org._id, includeInactive, true);

  const keyHex = getMasterKeyHex();
  if (!keyHex) {
    throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
  }
  const list = await Promise.all(
    boardMembers.map(async (bm) => {
      const obj = bm.toObject ? bm.toObject() : { ...bm };
      if (!obj.department && obj.position_id?.department_id?.name) {
        obj.department = obj.position_id.department_id.name;
      }
      decryptBoardMemberFields(obj, keyHex);
      if (bm.profile_picture_key) {
        try {
          obj.profile_picture_url = await getFileUrl(bm.profile_picture_key, 604800);
        } catch (err) {
          logError('Failed to resolve profile picture URL for list', err, { boardMemberId: bm._id });
        }
      }
      if (bm.contract?.file_key) {
        try {
          obj.contract = {
            ...(obj.contract || {}),
            file_url: await getFileUrl(bm.contract.file_key, 3600)
          };
        } catch (err) {
          logError('Failed to resolve contract URL for list', err, { boardMemberId: bm._id });
        }
      }
      return obj;
    })
  );

  res.json({
    success: true,
    data: list
  });
});

export const getBoardMemberById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  let boardMember = await boardMemberRepo.findByIdWithRelations(boardMemberId);
  if (!boardMember) {
    throw new AppError('Board member not found', 404, 'NOT_FOUND');
  }

  const obj = boardMember.toObject ? boardMember.toObject() : { ...boardMember };
  if (!obj.department && obj.position_id?.department_id?.name) {
    obj.department = obj.position_id.department_id.name;
  }
  const keyHex = getMasterKeyHex();
  if (!keyHex) {
    throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
  }
  decryptBoardMemberFields(obj, keyHex);

  // Resolve profile picture URL
  if (boardMember.profile_picture_key) {
    try {
      obj.profile_picture_url = await getFileUrl(boardMember.profile_picture_key, 604800);
    } catch (err) {
      logError('Failed to resolve profile picture URL', err, { boardMemberId: boardMember._id });
    }
  }
  if (boardMember.contract?.file_key) {
    try {
      obj.contract = {
        ...(obj.contract || {}),
        file_url: await getFileUrl(boardMember.contract.file_key, 3600)
      };
    } catch (err) {
      logError('Failed to resolve contract URL', err, { boardMemberId: boardMember._id });
    }
  }

  res.json({
    success: true,
    data: obj
  });
});

export const createBoardMember = asyncHandler(async (req, res) => {
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
  const { invite, system_access, is_volunteer, password, ...boardMemberData } = req.body;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Generate invitation token if invite is requested
  let invitationData = {};
  if (invite && system_access !== false) {
    const invitationToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // Expires in 7 days

    invitationData = {
      invitation_token: invitationToken,
      invitation_status: 'pending',
      invitation_expires_at: expiresAt,
      has_system_access: system_access !== false
    };
  }

  const boardMember = await boardMemberRepo.create({
    org_id: org._id,
    ...boardMemberData,
    is_volunteer: is_volunteer || false,
    ...invitationData
  });

  // Send invitation email if requested (for both regular staff and volunteers)
  if (invite && boardMemberData.email) {
    try {
      const recipientName = `${boardMemberData.given_names} ${boardMemberData.family_name}`;
      const position = boardMemberData.custom_position_title || boardMemberData.position;
      let volunteerActionLinks = null;
      if (is_volunteer) {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const [complaintDoc, riskDoc, coiDoc] = await Promise.all([
          createVolunteerActionToken({
            orgId,
            boardMemberId: boardMember._id,
            actionType: 'complaint',
            email: boardMemberData.email,
          }),
          createVolunteerActionToken({
            orgId,
            boardMemberId: boardMember._id,
            actionType: 'risk',
            email: boardMemberData.email,
          }),
          createVolunteerActionToken({
            orgId,
            boardMemberId: boardMember._id,
            actionType: 'coi',
            email: boardMemberData.email,
          }),
        ]);
        volunteerActionLinks = {
          complaint: `${frontendUrl}/public/volunteer/complaint/${complaintDoc.token}`,
          risk: `${frontendUrl}/public/volunteer/risk/${riskDoc.token}`,
          coi: `${frontendUrl}/public/volunteer/coi/${coiDoc.token}`,
        };
      }

      await emailService.sendBoardMemberInvitation({
        to: boardMemberData.email,
        recipientName,
        organizationName: org.name || 'Your Organization',
        position,
        invitationToken: invitationData.invitation_token,
        inviterName: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : null,
        volunteerActionLinks
      });

      // Update invitation status to sent
      await boardMemberRepo.updateInvitationStatus(boardMember._id, 'sent', {
        invitation_sent_at: new Date()
      });

      logInfo('Board member invitation sent', {
        boardMemberId: boardMember._id,
        email: boardMemberData.email,
        orgId
      });
    } catch (emailError) {
      logError('Failed to send board member invitation', emailError, {
        boardMemberId: boardMember._id,
        email: boardMemberData.email,
        orgId
      });
      // Don't fail the request if email fails - board member is still created
    }
  }

  // Manual mode: create user with password directly (no invite email)
  if (!invite && password && system_access !== false && boardMemberData.email) {
    try {
      const userRepo = new UserRepository(tenantDb);
      const existing = await userRepo.findByEmail(boardMemberData.email);
      if (existing) {
        // Link existing user
        await boardMemberRepo.update(boardMember._id, {
          user_id: existing._id,
          invitation_status: 'accepted',
          invitation_accepted_at: new Date(),
          has_system_access: true
        });
        logInfo('Board member linked to existing user (manual)', { boardMemberId: boardMember._id, userId: existing._id, orgId });
      } else {
        const SALT_ROUNDS = 12;
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        const newUser = await userRepo.create({
          email: boardMemberData.email,
          password_hash,
          first_name: boardMemberData.given_names,
          last_name: boardMemberData.family_name,
          status: 'active',
          created_by: req.user?.userId || null
        });
        await boardMemberRepo.update(boardMember._id, {
          user_id: newUser._id,
          invitation_status: 'accepted',
          invitation_accepted_at: new Date(),
          has_system_access: true
        });
        logInfo('Board member user created manually', { boardMemberId: boardMember._id, userId: newUser._id, orgId });
      }
    } catch (userError) {
      logError('Failed to create user for board member (manual)', userError, {
        boardMemberId: boardMember._id,
        email: boardMemberData.email,
        orgId
      });
      // Board member is still created, but user creation failed
    }
  }

  // Update progress if this is the first board member
  const count = await boardMemberRepo.countByOrgId(org._id);
  if (count === 1) {
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    await progressRepo.updateProfileStep(org._id, 'responsible_people_complete', true);
  }

  const createObj = boardMember.toObject ? boardMember.toObject() : { ...boardMember };
  const keyHex = getMasterKeyHex();
  if (!keyHex) {
    throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
  }
  decryptBoardMemberFields(createObj, keyHex);
  
  // Resolve profile picture URL
  if (boardMember.profile_picture_key) {
    try {
      createObj.profile_picture_url = await getFileUrl(boardMember.profile_picture_key, 604800);
    } catch (err) {
      logError('Failed to resolve profile picture URL', err, { boardMemberId: boardMember._id });
    }
  }
  if (boardMember.contract?.file_key) {
    try {
      createObj.contract = {
        ...(createObj.contract || {}),
        file_url: await getFileUrl(boardMember.contract.file_key, 3600)
      };
    } catch (err) {
      logError('Failed to resolve contract URL', err, { boardMemberId: boardMember._id });
    }
  }
  
  res.status(201).json({
    success: true,
    data: createObj
  });
});

export const updateBoardMember = asyncHandler(async (req, res) => {
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
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const boardMember = await boardMemberRepo.update(boardMemberId, req.body);
  if (!boardMember) {
    throw new AppError('Board member not found', 404, 'NOT_FOUND');
  }

  const obj = boardMember.toObject ? boardMember.toObject() : { ...boardMember };
  const keyHex = getMasterKeyHex();
  if (!keyHex) {
    throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
  }
  decryptBoardMemberFields(obj, keyHex);
  
  // Resolve profile picture URL
  if (boardMember.profile_picture_key) {
    try {
      obj.profile_picture_url = await getFileUrl(boardMember.profile_picture_key, 604800);
    } catch (err) {
      logError('Failed to resolve profile picture URL', err, { boardMemberId: boardMember._id });
    }
  }
  if (boardMember.contract?.file_key) {
    try {
      obj.contract = {
        ...(obj.contract || {}),
        file_url: await getFileUrl(boardMember.contract.file_key, 3600)
      };
    } catch (err) {
      logError('Failed to resolve contract URL', err, { boardMemberId: boardMember._id });
    }
  }
  
  res.json({
    success: true,
    data: obj
  });
});

export const deleteBoardMember = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const userRepo = new UserRepository(tenantDb);
  const boardMember = await boardMemberRepo.findById(boardMemberId);
  if (!boardMember) {
    throw new AppError('Board member not found', 404, 'NOT_FOUND');
  }

  const now = new Date();
  const userId = boardMember.user_id?.toString?.() || null;
  let offboardedUser = null;
  if (userId) {
    const user = await userRepo.findById(userId);
    if (user) {
      const originalEmail = String(user.email || '').trim();
      // Free up the original email for reuse while retaining a unique offboarded address on the user record.
      const safeLocal = originalEmail.includes('@') ? originalEmail.split('@')[0] : 'user';
      const offboardedEmail = `offboarded+${Date.now()}-${safeLocal}@offboarded.local`;
      offboardedUser = await userRepo.update(userId, {
        status: 'inactive',
        locked: true,
        locked_until: null,
        mfa_enabled: false,
        mfa_secret: null,
        email: offboardedEmail
      });
    }
  }

  await boardMemberRepo.delete(boardMemberId, {
    has_system_access: false,
    invitation_status: 'expired',
    user_id: null,
    position_id: null,
    status: 'removed',
    offboarded_at: now
  });

  const actorId = req.user?.userId ? String(req.user.userId) : null;
  await tenantDb.collection('access_change_logs').insertOne({
    org_id: boardMember.org_id,
    user_id: userId,
    board_member_id: boardMember._id,
    changed_by: actorId,
    action: 'user_offboarded',
    module: 'offboarding',
    details: {
      reason: 'Responsible person removed/offboarded',
      access_revoked: true,
      email_reassigned: !!offboardedUser
    },
    created_at: now
  });

  res.json({
    success: true,
    message: 'Responsible person offboarded successfully'
  });
});

/**
 * Get departments and roles reference data
 * Returns the list of departments and their associated positions from the database
 */
export const getDepartmentsAndRoles = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);

  // Import repositories
  const { DepartmentRepository } = await import('../repositories/departmentRepository.js');
  const { PositionRepository } = await import('../repositories/positionRepository.js');
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');

  const orgRepo = new OrganizationRepository(tenantDb);
  const departmentRepo = new DepartmentRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  // Get organization
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Get all active departments
  const departments = await departmentRepo.findByOrgId(org._id);

  // Get all active positions
  const positions = await positionRepo.findByOrgId(org._id);

  // Determine which positions are held by active board members (is_board_member=true)
  const boardMembers = await boardMemberRepo.BoardMember.find({
    org_id: org._id,
    is_active: true,
    is_board_member: true,
    position_id: { $ne: null }
  }).lean();
  const boardPositionIds = new Set(
    boardMembers
      .map((bm) => bm.position_id?.toString?.())
      .filter(Boolean)
  );

  // Group positions by department
  const departmentsWithRoles = departments.map(dept => {
    const deptPositions = positions.filter(
      pos => pos.department_id?.toString() === dept._id.toString()
    );

    return {
      id: dept._id.toString(),
      name: dept.name,
      code: dept.code,
      description: dept.description,
      roles: deptPositions.map(pos => {
        const modulePermissions = {};
        (pos.module_permissions || []).forEach(mp => {
          if (mp && mp.module_id) {
            modulePermissions[mp.module_id] = {
              view: !!mp.view,
              edit: !!mp.edit,
              delete: !!mp.delete
            };
          }
        });
        return {
          id: pos._id.toString(),
          name: pos.title,
          level: pos.level,
          isManagement: pos.is_management,
          // Derived flag: true when at least one active board member holds this position
          is_board_level: boardPositionIds.has(pos._id.toString()),
          granted_permissions: pos.granted_permissions || [],
          modulePermissions
        };
      })
    };
  });

  res.json({
    success: true,
    data: departmentsWithRoles
  });
});

/**
 * Create a department at runtime (from Add Responsible Person form)
 */
export const createDepartment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const { DepartmentRepository } = await import('../repositories/departmentRepository.js');
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');

  const orgRepo = new OrganizationRepository(tenantDb);
  const departmentRepo = new DepartmentRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const { name, code } = req.body;
  if (!name || !String(name).trim()) {
    throw new AppError('Department name is required', 400, 'VALIDATION_ERROR');
  }

  const trimmedName = String(name).trim();
  const existing = await departmentRepo.findByOrgId(org._id);
  if (existing.some(d => d.name.toLowerCase() === trimmedName.toLowerCase())) {
    throw new AppError('A department with this name already exists', 400, 'DUPLICATE_DEPARTMENT');
  }

  const codeValue = code && String(code).trim() ? String(code).trim().toUpperCase().substring(0, 20) : trimmedName.substring(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'D';
  const department = await departmentRepo.create({
    org_id: org._id,
    name: trimmedName,
    code: codeValue,
    is_active: true
  });

  res.status(201).json({
    success: true,
    data: {
      id: department._id.toString(),
      name: department.name,
      code: department.code
    }
  });
});

/**
 * Create a position/role at runtime (from Add Responsible Person form)
 */
export const createPosition = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const { PositionRepository } = await import('../repositories/positionRepository.js');
  const { DepartmentRepository } = await import('../repositories/departmentRepository.js');
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');

  const orgRepo = new OrganizationRepository(tenantDb);
  const departmentRepo = new DepartmentRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const { title, department_id } = req.body;
  if (!title || !String(title).trim()) {
    throw new AppError('Position/role title is required', 400, 'VALIDATION_ERROR');
  }
  if (!department_id) {
    throw new AppError('Department is required to create a role', 400, 'VALIDATION_ERROR');
  }

  const trimmedTitle = String(title).trim();
  const department = await departmentRepo.findById(department_id);
  if (!department || department.org_id.toString() !== org._id.toString()) {
    throw new AppError('Department not found', 404, 'DEPARTMENT_NOT_FOUND');
  }

  const existingPositions = await positionRepo.findByDepartment(org._id, department_id);
  if (existingPositions.some(p => p.title.toLowerCase() === trimmedTitle.toLowerCase())) {
    throw new AppError('A role with this name already exists in this department', 400, 'DUPLICATE_POSITION');
  }

  const granted_permissions = Array.isArray(req.body.granted_permissions)
    ? req.body.granted_permissions.filter(p => typeof p === 'string' && p.trim())
    : [];

  const position = await positionRepo.create({
    org_id: org._id,
    title: trimmedTitle,
    department_id: department._id,
    level: 1,
    is_active: true,
    granted_permissions
  });

  res.status(201).json({
    success: true,
    data: {
      id: position._id.toString(),
      name: position.title,
      title: position.title,
      department_id: position.department_id?.toString(),
      granted_permissions: position.granted_permissions || []
    }
  });
});

/**
 * Update a position (e.g. set granted_permissions so this position can create/assign training)
 */
export const updatePosition = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { positionId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const { PositionRepository } = await import('../repositories/positionRepository.js');
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');

  const orgRepo = new OrganizationRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const position = await positionRepo.findById(positionId);
  if (!position || position.org_id.toString() !== org._id.toString()) {
    throw new AppError('Position not found', 404, 'POSITION_NOT_FOUND');
  }

  const granted_permissions = Array.isArray(req.body.granted_permissions)
    ? req.body.granted_permissions.filter(p => typeof p === 'string' && p.trim())
    : position.granted_permissions || [];

  const updated = await positionRepo.update(positionId, { granted_permissions });

  res.json({
    success: true,
    data: {
      id: updated._id.toString(),
      name: updated.title,
      title: updated.title,
      department_id: updated.department_id?.toString(),
      granted_permissions: updated.granted_permissions || []
    }
  });
});

export const updateSuitability = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  const existingSuitability = member.suitability_check || {};
  const existingItems = Array.isArray(existingSuitability.items) ? existingSuitability.items : [];
  const itemsByType = new Map(existingItems.map((item) => [item.type, { ...(item?.toObject ? item.toObject() : item) }]));

  if (Array.isArray(req.body?.items)) {
    req.body.items.forEach((incoming) => {
      const type = String(incoming?.type || '').trim();
      if (!NORMALIZED_SUITABILITY_TYPES.has(type)) return;
      const prev = itemsByType.get(type) || { type };
      const next = { ...prev };
      if (typeof incoming.completed === 'boolean') next.completed = incoming.completed;
      if (Object.prototype.hasOwnProperty.call(incoming, 'completed_at')) {
        next.completed_at = incoming.completed_at ? new Date(incoming.completed_at) : null;
      }
      if (Object.prototype.hasOwnProperty.call(incoming, 'expires_at')) {
        next.expires_at = incoming.expires_at ? new Date(incoming.expires_at) : null;
      }
      if (Object.prototype.hasOwnProperty.call(incoming, 'comments')) {
        next.comments = String(incoming.comments || '').trim();
      }
      if (next.completed && !next.completed_at) next.completed_at = new Date();
      if (!next.completed) next.completed_at = null;
      itemsByType.set(type, next);
    });
  }

  let directorId = member.director_id ? (member.director_id.toObject ? member.director_id.toObject() : { ...member.director_id }) : {};
  if (req.body?.director_id && typeof req.body.director_id === 'object') {
    directorId = {
      ...directorId,
      number: Object.prototype.hasOwnProperty.call(req.body.director_id, 'number')
        ? String(req.body.director_id.number || '').trim()
        : (directorId.number || '')
    };
  }

  const mergedItems = Array.from(itemsByType.values());
  const nextReviewDate = mergedItems
    .map((item) => (item?.expires_at ? new Date(item.expires_at) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b)[0] || null;

  const suitability_check = {
    ...existingSuitability,
    items: mergedItems,
    next_review_date: nextReviewDate
  };
  suitability_check.status = computeSuitabilityStatus(suitability_check);

  const updated = await boardMemberRepo.update(boardMemberId, {
    suitability_check,
    director_id: directorId
  });

  res.json({ success: true, data: updated });
});

export const uploadSuitabilityDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  const itemType = String(req.body?.item_type || '').trim();
  if (!itemType) throw new AppError('item_type is required', 400, 'VALIDATION_ERROR');

  const { buffer, originalname, mimetype } = req.file;
  const { key } = await uploadToS3(buffer, originalname, mimetype, orgId, 'suitability');
  const uploadedAt = new Date();

  if (itemType === 'director_id') {
    const existingDirectorId = member.director_id ? (member.director_id.toObject ? member.director_id.toObject() : { ...member.director_id }) : {};
    const director_id = {
      ...existingDirectorId,
      number: String(req.body?.director_id_number || existingDirectorId.number || '').trim(),
      document_key: key,
      document_name: originalname,
      document_type: mimetype,
      uploaded_at: uploadedAt,
      verified_at: uploadedAt
    };
    const updated = await boardMemberRepo.update(boardMemberId, { director_id });
    return res.json({ success: true, data: updated });
  }

  if (!NORMALIZED_SUITABILITY_TYPES.has(itemType)) {
    throw new AppError('Unsupported suitability item type', 400, 'VALIDATION_ERROR');
  }

  const existingSuitability = member.suitability_check || {};
  const existingItems = Array.isArray(existingSuitability.items) ? existingSuitability.items : [];
  const itemsByType = new Map(existingItems.map((item) => [item.type, { ...(item?.toObject ? item.toObject() : item) }]));

  const current = itemsByType.get(itemType) || { type: itemType };
  const nextItem = {
    ...current,
    type: itemType,
    document_key: key,
    document_name: originalname,
    document_type: mimetype,
    uploaded_at: uploadedAt,
    comments: Object.prototype.hasOwnProperty.call(req.body, 'comments')
      ? String(req.body.comments || '').trim()
      : (current.comments || ''),
    expires_at: req.body?.expires_at ? new Date(req.body.expires_at) : (current.expires_at || null),
    completed: current.completed ?? false,
    completed_at: current.completed_at || null
  };
  itemsByType.set(itemType, nextItem);

  const mergedItems = Array.from(itemsByType.values());
  const nextReviewDate = mergedItems
    .map((item) => (item?.expires_at ? new Date(item.expires_at) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b)[0] || null;

  const suitability_check = {
    ...existingSuitability,
    items: mergedItems,
    next_review_date: nextReviewDate
  };
  suitability_check.status = computeSuitabilityStatus(suitability_check);

  const updated = await boardMemberRepo.update(boardMemberId, { suitability_check });
  return res.json({ success: true, data: updated });
});

export const getSuitabilityBulkStatus = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const rows = await boardMemberRepo.BoardMember.find({
    is_active: true
  }).select('_id suitability_check').lean();

  const data = rows.map((row) => {
    const suitability = row?.suitability_check || {};
    return {
      board_member_id: row?._id,
      status: suitability?.status || computeSuitabilityStatus(suitability),
      next_review_date: suitability?.next_review_date || null
    };
  });

  res.json({ success: true, data });
});

// ─── WWCC Certificate ───────────────────────────────────────────────

export const uploadWwcc = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  const { buffer, originalname, mimetype } = req.file;
  const { key } = await uploadToS3(buffer, originalname, mimetype, orgId, 'wwcc');

  const expiryDate = req.body.expiry_date ? new Date(req.body.expiry_date) : null;
  const cardNumber = req.body.card_number || null;

  const wwccData = {
    file_key: key,
    file_name: originalname,
    file_type: mimetype,
    uploaded_at: new Date(),
    expiry_date: expiryDate,
    card_number: cardNumber,
    status: expiryDate && expiryDate < new Date() ? 'expired' : 'valid'
  };

  await boardMemberRepo.update(boardMemberId, { wwcc: wwccData });

  logInfo('WWCC certificate uploaded', { boardMemberId, orgId });

  res.json({ success: true, data: wwccData });
});

export const viewWwcc = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');
  if (!member.wwcc?.file_key) throw new AppError('No WWCC certificate on file', 404, 'NO_FILE');

  const url = await getFileUrl(member.wwcc.file_key, 3600);
  res.json({ success: true, data: { url, file_name: member.wwcc.file_name, file_type: member.wwcc.file_type } });
});

export const deleteWwcc = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  await boardMemberRepo.update(boardMemberId, {
    wwcc: { file_key: null, file_name: null, file_type: null, uploaded_at: null, expiry_date: null, card_number: null, status: 'not_uploaded' }
  });

  logInfo('WWCC certificate deleted', { boardMemberId, orgId });
  res.json({ success: true, message: 'WWCC certificate removed' });
});

// ─── Police Check Certificate ────────────────────────────────────────

export const uploadPoliceCheck = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  const { buffer, originalname, mimetype } = req.file;
  const { key } = await uploadToS3(buffer, originalname, mimetype, orgId, 'police-check');

  const expiryDate = req.body.expiry_date ? new Date(req.body.expiry_date) : null;
  const certificateNumber = req.body.certificate_number || null;

  const policeData = {
    file_key: key,
    file_name: originalname,
    file_type: mimetype,
    uploaded_at: new Date(),
    expiry_date: expiryDate,
    certificate_number: certificateNumber,
    status: expiryDate && expiryDate < new Date() ? 'expired' : 'valid'
  };

  await boardMemberRepo.update(boardMemberId, { police_check: policeData });

  logInfo('Police check certificate uploaded', { boardMemberId, orgId });

  res.json({ success: true, data: policeData });
});

export const viewPoliceCheck = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');
  if (!member.police_check?.file_key) throw new AppError('No police check certificate on file', 404, 'NO_FILE');

  const url = await getFileUrl(member.police_check.file_key, 3600);
  res.json({ success: true, data: { url, file_name: member.police_check.file_name, file_type: member.police_check.file_type } });
});

export const deletePoliceCheck = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  await boardMemberRepo.update(boardMemberId, {
    police_check: { file_key: null, file_name: null, file_type: null, uploaded_at: null, expiry_date: null, certificate_number: null, status: 'not_uploaded' }
  });

  logInfo('Police check certificate deleted', { boardMemberId, orgId });
  res.json({ success: true, message: 'Police check certificate removed' });
});

// ─── Contract file upload / view / delete ─────────────────────────────

export const uploadContract = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  const { buffer, originalname, mimetype } = req.file;
  const { key } = await uploadToS3(buffer, originalname, mimetype, orgId, 'contracts');

  const contractData = {
    file_key: key,
    file_name: originalname,
    file_type: mimetype,
    uploaded_at: new Date()
  };

  await boardMemberRepo.update(boardMemberId, { contract: contractData });
  logInfo('Contract uploaded', { boardMemberId, orgId });

  const file_url = await getFileUrl(key, 3600);
  res.json({ success: true, data: { ...contractData, file_url } });
});

export const viewContract = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');
  if (!member.contract?.file_key) throw new AppError('No contract file on record', 404, 'NO_FILE');

  const url = await getFileUrl(member.contract.file_key, 3600);
  res.json({
    success: true,
    data: { url, file_name: member.contract.file_name, file_type: member.contract.file_type }
  });
});

export const deleteContract = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const member = await boardMemberRepo.findById(boardMemberId);
  if (!member) throw new AppError('Board member not found', 404, 'NOT_FOUND');

  await boardMemberRepo.update(boardMemberId, {
    contract: { file_key: null, file_name: null, file_type: null, uploaded_at: null }
  });

  logInfo('Contract deleted', { boardMemberId, orgId });
  res.json({ success: true, message: 'Contract removed' });
});

// ─── Directors Handbook upload / view ─────────────────────────────

export const uploadDirectorsHandbook = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

  const tenantDb = await getTenantConnection(orgId);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const { buffer, originalname, mimetype } = req.file;
  const { key } = await uploadToS3(buffer, originalname, mimetype, orgId, 'directors-handbook');

  const handbookName = String(req.body?.handbook_name || '').trim() || 'Directors Handbook';
  const handbookData = {
    handbook_name: handbookName,
    file_key: key,
    file_name: originalname,
    file_type: mimetype,
    uploaded_at: new Date(),
    uploaded_by: req.user?.userId || null
  };

  const metadata = { ...(org.metadata || {}), directors_handbook: handbookData };
  await orgRepo.update({ metadata });

  const file_url = await getFileUrl(key, 3600);
  res.json({ success: true, data: { ...handbookData, file_url } });
});

export const viewDirectorsHandbook = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const boardMemberRecords = await boardMemberRepo.findAllActiveByUserId(req.user?.userId, org._id);
  const boardRoleRegex = /(board|director|trustee|committee)/i;
  const canViewHandbook = Array.isArray(boardMemberRecords) && boardMemberRecords.some((bm) => {
    if (bm?.is_board_member) return true;
    const title = `${bm?.custom_position_title || ''} ${bm?.position || ''}`.trim();
    return boardRoleRegex.test(title);
  });
  if (!canViewHandbook) {
    throw new AppError('Only board members can view directors handbook', 403, 'FORBIDDEN');
  }

  const handbook = org.metadata?.directors_handbook;
  if (!handbook?.file_key) throw new AppError('No directors handbook on record', 404, 'NO_FILE');

  const url = await getFileUrl(handbook.file_key, 3600);
  res.json({
    success: true,
    data: {
      url,
      handbook_name: handbook.handbook_name || 'Directors Handbook',
      file_name: handbook.file_name,
      file_type: handbook.file_type,
      uploaded_at: handbook.uploaded_at || null
    }
  });
});
