/**
 * Board Member Controller
 *
 * Handles HTTP requests for responsible people (board members)
 */

import crypto from 'crypto';
import { getTenantConnection } from '../db/connectionManager.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';
import emailService from '../services/emailService.js';
import { getFileUrl } from '../services/s3Service.js';
import { logInfo, logError } from '../utils/logger.js';
import { decryptBoardMemberFields, decryptBoardMemberList } from '../utils/decryptBoardMember.js';

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
  const { invite, system_access, is_volunteer, ...boardMemberData } = req.body;
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

  // Send invitation email if requested
  if (invite && system_access !== false && boardMemberData.email) {
    try {
      const recipientName = `${boardMemberData.given_names} ${boardMemberData.family_name}`;
      const position = boardMemberData.custom_position_title || boardMemberData.position;

      await emailService.sendBoardMemberInvitation({
        to: boardMemberData.email,
        recipientName,
        organizationName: org.name || 'Your Organization',
        position,
        invitationToken: invitationData.invitation_token,
        inviterName: req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : null
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

  await boardMemberRepo.delete(boardMemberId);

  res.json({
    success: true,
    message: 'Board member deleted successfully'
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

  const orgRepo = new OrganizationRepository(tenantDb);
  const departmentRepo = new DepartmentRepository(tenantDb);
  const positionRepo = new PositionRepository(tenantDb);

  // Get organization
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Get all active departments
  const departments = await departmentRepo.findByOrgId(org._id);

  // Get all active positions
  const positions = await positionRepo.findByOrgId(org._id);

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
