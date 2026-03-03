/**
 * User Controller
 * Team member listing for attendees
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
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
  const boardMembers = await boardMemberRepo.findByOrgId(org._id);
  const boardMemberByUserId = new Map(
    boardMembers.map((bm) => [bm.user_id?.toString(), bm])
  );

  const data = await Promise.all(users.map(async (user) => {
    const userIdStr = user._id?.toString();
    const boardMember = boardMemberByUserId.get(userIdStr);
    const profileKey = boardMember?.profile_picture_key || user.profile_picture_key;
    const positionId = boardMember?.position_id?._id?.toString?.() || boardMember?.position_id?.toString?.() || null;
    const department = boardMember?.department || null;
    let avatar = null;

    if (profileKey) {
      try {
        avatar = await getFileUrl(profileKey, 604800);
      } catch (err) {
        avatar = null;
      }
    }

    return {
      id: userIdStr,
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      email: user.email || '',
      avatar,
      positionId,
      department
    };
  }));

  res.json({
    success: true,
    data
  });
});
