/**
 * Board Member Controller
 *
 * Handles HTTP requests for responsible people (board members)
 */

import crypto from 'crypto';
import { getTenantConnection } from '../db/connectionManager.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';
import emailService from '../services/emailService.js';
import { logInfo, logError } from '../utils/logger.js';

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
  const boardMembers = await boardMemberRepo.findByOrgId(org._id, includeInactive);

  res.json({
    success: true,
    data: boardMembers
  });
});

export const getBoardMemberById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  const boardMember = await boardMemberRepo.findById(boardMemberId);
  if (!boardMember) {
    throw new AppError('Board member not found', 404, 'NOT_FOUND');
  }

  res.json({
    success: true,
    data: boardMember
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
  const { invite, system_access, ...boardMemberData } = req.body;
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

  res.status(201).json({
    success: true,
    data: boardMember
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

  res.json({
    success: true,
    data: boardMember
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
 * Returns the list of departments and their associated roles
 */
export const getDepartmentsAndRoles = asyncHandler(async (req, res) => {
  // Reference data for departments and roles
  const departments = [
    {
      id: 'leadership',
      name: 'Leadership',
      roles: [
        { id: 'chair', name: 'Chair' },
        { id: 'deputy_chair', name: 'Deputy Chair' },
        { id: 'director', name: 'Director' }
      ]
    },
    {
      id: 'finance',
      name: 'Finance',
      roles: [
        { id: 'treasurer', name: 'Treasurer' },
        { id: 'finance_committee_member', name: 'Finance Committee Member' }
      ]
    },
    {
      id: 'governance',
      name: 'Governance',
      roles: [
        { id: 'secretary', name: 'Secretary' },
        { id: 'trustee', name: 'Trustee' },
        { id: 'committee_member', name: 'Committee Member' }
      ]
    },
    {
      id: 'operations',
      name: 'Operations',
      roles: [
        { id: 'operations_manager', name: 'Operations Manager' },
        { id: 'program_manager', name: 'Program Manager' }
      ]
    },
    {
      id: 'volunteer',
      name: 'Volunteer',
      roles: []
    }
  ];

  res.json({
    success: true,
    data: departments
  });
});
