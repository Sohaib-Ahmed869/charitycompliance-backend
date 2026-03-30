/**
 * Profile Controller (current user's own profile)
 * GET /me/profile, POST /me/profile/picture
 * Supports both board members and org owners (admins); org owners use User.profile_picture_key.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { uploadToS3, getFileUrl } from '../services/s3Service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError } from '../utils/logger.js';

/**
 * Resolves tenant, org, current user, and board member (if any).
 * Allows access for any authenticated user in the tenant DB (org owner or board member).
 */
async function getTenantAndProfileContext(req) {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  if (!userId) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const tenantDb = await getTenantConnection(orgId);
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'NOT_FOUND');
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const boardMember = await boardMemberRepo.findByUserId(userId, org._id);
  return { org, boardMember, user, orgId, tenantDb, boardMemberRepo, userRepo };
}

/** GET /me/profile - current user's profile (position, name, profile picture URL) */
export const getProfile = asyncHandler(async (req, res) => {
  const { boardMember, user } = await getTenantAndProfileContext(req);
  let profile_picture_url = null;
  const pictureKey = boardMember?.profile_picture_key ?? user?.profile_picture_key;
  if (pictureKey) {
    try {
      profile_picture_url = await getFileUrl(pictureKey, 604800);
    } catch (err) {
      logError('Failed to resolve profile picture URL', err, { userId: user._id });
    }
  }
  const firstName = boardMember ? (boardMember.given_names || '') : (user.first_name || '');
  const lastName = boardMember ? (boardMember.family_name || '') : (user.last_name || '');
  const position = user.is_auditor
    ? 'Auditor'
    : boardMember
      ? (boardMember.custom_position_title || boardMember.position || null)
      : 'Admin';
  res.json({
    success: true,
    data: {
      firstName,
      lastName,
      position,
      profile_picture_url
    }
  });
});

/** POST /me/profile/picture - upload profile picture (multipart file) */
export const uploadProfilePicture = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    throw new AppError('No file uploaded', 400, 'VALIDATION_ERROR');
  }
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) {
    throw new AppError('Invalid file type. Use JPEG, PNG, GIF or WebP.', 400, 'INVALID_FILE_TYPE');
  }
  const { org, boardMember, user, orgId, boardMemberRepo, userRepo } = await getTenantAndProfileContext(req);
  const ext = req.file.originalname?.split('.').pop()?.toLowerCase() || 'jpg';
  const entityId = boardMember?._id ?? user._id;
  const fileName = `avatar-${entityId}.${ext}`;
  const { key } = await uploadToS3(
    req.file.buffer,
    fileName,
    req.file.mimetype,
    orgId,
    'profile'
  );
  if (boardMember) {
    await boardMemberRepo.update(boardMember._id, { profile_picture_key: key });
  } else {
    await userRepo.update(user._id, { profile_picture_key: key });
  }
  let profile_picture_url = null;
  try {
    profile_picture_url = await getFileUrl(key, 604800);
  } catch (err) {
    logError('Failed to resolve profile picture URL after upload', err, { key });
  }
  res.json({
    success: true,
    data: { profile_picture_url }
  });
});
