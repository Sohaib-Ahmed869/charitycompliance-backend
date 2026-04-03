/**
 * User Controller
 * Team member listing for attendees
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { getFileUrl } from '../services/s3Service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';

export const listTeamMembers = asyncHandler(async (req, res) => {
  const userId = req.user?.userId;
  const orgId = req.orgId;
  if (!userId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const tenantDb = await getTenantConnection(orgId);
  const userRepo = new UserRepository(tenantDb);
  const users = await userRepo.listActiveUsers(userId);

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const boardMembers = await boardMemberRepo.findByOrgId(org._id, false, true);
  const boardMemberByUserId = new Map(
    boardMembers
      .filter((bm) => bm.user_id)
      .map((bm) => [bm.user_id?.toString(), bm])
  );

  // Build position titles per user (UserPosition + BoardMember)
  const userPositionRepo = new UserPositionRepository(tenantDb);
  const userPositions = await userPositionRepo.findByOrgId(org._id);
  const positionTitlesByUserId = new Map();
  for (const up of userPositions || []) {
    const uid = up.user_id?._id?.toString() || up.user_id?.toString();
    if (!uid) continue;
    const title = up.position_id?.title || up.position_id;
    if (title && typeof title === 'string') {
      const existing = positionTitlesByUserId.get(uid) || new Set();
      existing.add(title);
      positionTitlesByUserId.set(uid, existing);
    }
  }
  for (const [uid, bm] of boardMemberByUserId) {
    const title = bm.position_id?.title || bm.custom_position_title || bm.position;
    if (title && typeof title === 'string') {
      const existing = positionTitlesByUserId.get(uid) || new Set();
      existing.add(title);
      positionTitlesByUserId.set(uid, existing);
    }
  }

  const data = await Promise.all(users.map(async (user) => {
    const userIdStr = user._id?.toString();
    const boardMember = boardMemberByUserId.get(userIdStr);
    const profileKey = boardMember?.profile_picture_key || user.profile_picture_key;
    let avatar = null;

    if (profileKey) {
      try {
        avatar = await getFileUrl(profileKey, 604800);
      } catch (err) {
        avatar = null;
      }
    }

    const positionSet = positionTitlesByUserId.get(userIdStr);
    const position = positionSet ? [...positionSet].join(', ') : '';

    return {
      id: userIdStr,
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      email: user.email || '',
      position,
      avatar
    };
  }));

  res.json({
    success: true,
    data
  });
});

export const inviteAuditor = asyncHandler(async (req, res) => {
  const userId = req.user?.userId;
  const orgId = req.orgId;
  const { email, firstName = '', lastName = '' } = req.body;

  if (!userId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const tenantDb = await getTenantConnection(orgId);

  // Check if user already exists with this email
  const existingUser = await UserRepository.findByEmail(email, tenantDb);
  if (existingUser) {
    throw new AppError('User with this email already exists', 409, 'USER_EXISTS');
  }

  // Create auditor invite record
  const auditorInvite = {
    email,
    firstName,
    lastName,
    invitedAt: new Date(),
    invitedBy: userId,
    status: 'pending',
    role: 'auditor'
  };

  // Store invite in database (assuming there's an AuditorInvite model)
  const result = await tenantDb.collection('auditor_invites').insertOne(auditorInvite);

  res.json({
    success: true,
    data: {
      _id: result.insertedId,
      email,
      firstName,
      lastName,
      status: 'pending',
      invitedAt: auditorInvite.invitedAt
    }
  });
});
