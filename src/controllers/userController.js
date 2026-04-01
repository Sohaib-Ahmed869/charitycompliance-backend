/**
 * User Controller
 * Team member listing for attendees
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { getFileUrl } from '../services/s3Service.js';
import emailService from '../services/emailService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';
import { ensureEmailNotInOtherTenants } from '../utils/ensureEmailNotInOtherTenants.js';

const SALT_ROUNDS = 12;

/** Readable temp password for auditor invite (no ambiguous 0/O/1/l). */
function generateAuditorTempPassword(length = 14) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

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

/**
 * Invite external auditor (org owner only). Creates tenant User with is_auditor; emails temp password + org ID.
 */
export const inviteAuditor = asyncHandler(async (req, res) => {
  const inviterId = req.user?.userId;
  const orgId = req.orgId;
  if (!inviterId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const tenantDb = await getTenantConnection(orgId);
  const userRepo = new UserRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const inviter = await userRepo.findById(inviterId);
  if (!inviter?.is_org_owner) {
    throw new AppError('Only the organisation owner can invite auditors.', 403, 'FORBIDDEN');
  }

  const { email, firstName, lastName } = req.body;
  const normalizedEmail = String(email).toLowerCase().trim();

  // Stop cross-organisation collisions: auditor accounts must not re-use an email from another tenant.
  await ensureEmailNotInOtherTenants(normalizedEmail, orgId);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const existing = await userRepo.findByEmail(normalizedEmail);
  if (existing) {
    if (existing.is_auditor) {
      return res.status(200).json({
        success: true,
        message: 'This email already has auditor access.'
      });
    }
    if (existing.is_org_owner) {
      throw new AppError('This email belongs to the organisation owner.', 409, 'CONFLICT');
    }
    throw new AppError(
      'This email is already registered as a team member. Auditors need a dedicated account.',
      409,
      'USER_EXISTS'
    );
  }

  const tempPassword = generateAuditorTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const newUser = await userRepo.create({
    email: normalizedEmail,
    password_hash,
    first_name: firstName || '',
    last_name: lastName || '',
    status: 'active',
    is_auditor: true,
    is_org_owner: false,
    mfa_enabled: false,
    created_by: inviterId
  });

  const recipientName = [firstName, lastName].filter(Boolean).join(' ') || 'there';
  const inviterName = inviter.first_name && inviter.last_name
    ? `${inviter.first_name} ${inviter.last_name}`.trim()
    : (inviter.first_name || inviter.last_name || '');

  try {
    await emailService.sendAuditorInviteEmail({
      to: normalizedEmail,
      recipientName,
      organizationName: org.name || 'Your organisation',
      orgId,
      tempPassword,
      inviterName: inviterName || null
    });
    logInfo('Auditor invite email sent', { userId: newUser._id, email: normalizedEmail, orgId });
  } catch (emailErr) {
    logError('Failed to send auditor invite email', emailErr, { userId: newUser._id, email: normalizedEmail, orgId });
    const UserModel = tenantDb.model('User');
    await UserModel.findByIdAndDelete(newUser._id);
    throw new AppError(
      'Could not send the invitation email. Please check email configuration and try again.',
      502,
      'EMAIL_SEND_FAILED'
    );
  }

  res.status(201).json({
    success: true,
    message: 'Invitation sent. The auditor will receive an email with a temporary password and your organisation ID.'
  });
});
