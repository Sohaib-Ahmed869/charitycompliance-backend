/**
 * Board Member Controller
 * 
 * Handles HTTP requests for responsible people (board members)
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';

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
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new (await import('../repositories/organizationRepository.js')).OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const boardMember = await boardMemberRepo.create({
    org_id: org._id,
    ...req.body
  });

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
