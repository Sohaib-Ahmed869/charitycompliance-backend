/**
 * User Controller
 * Team member listing for attendees
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
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

  const data = users.map((user) => ({
    id: user._id?.toString(),
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    email: user.email || ''
  }));

  res.json({
    success: true,
    data
  });
});
