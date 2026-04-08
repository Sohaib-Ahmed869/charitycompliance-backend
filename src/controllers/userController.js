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
  const userRepo = new UserRepository(tenantDb);

  const existingUser = await userRepo.findByEmail(email);
  if (existingUser) {
    throw new AppError('A user with this email already exists in your organisation', 409, 'USER_EXISTS');
  }

  const crypto = await import('crypto');
  const bcrypt = await import('bcryptjs');
  const tempPassword = crypto.default.randomBytes(10).toString('base64url').slice(0, 14);
  const SALT_ROUNDS = 12;
  const password_hash = await bcrypt.default.hash(tempPassword, SALT_ROUNDS);

  const newUser = await userRepo.create({
    email,
    password_hash,
    first_name: firstName || 'Auditor',
    last_name: lastName || '',
    status: 'active',
    is_auditor: true,
    is_org_owner: false,
    created_by: userId,
  });

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const orgName = org?.name || 'Your Organisation';

  const emailService = (await import('../services/emailService.js')).default;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  try {
    const html = `
      <div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px">
        <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#132e5e;text-align:center">Auditor Access Granted</h1>
        <p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#333;text-align:center">
          Hi ${firstName || 'Auditor'},
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:#333;text-align:center">
          You have been granted <strong>read-only auditor access</strong> to <strong>${orgName}</strong> on Stewardex.
        </p>
        <div style="background:#f1f5f9;border-radius:10px;padding:16px 20px;margin:0 0 20px;text-align:center">
          <p style="margin:0 0 6px;font-size:13px;color:#475569"><strong>Email:</strong> ${email}</p>
          <p style="margin:0;font-size:13px;color:#475569"><strong>Temporary password:</strong> ${tempPassword}</p>
        </div>
        <div style="text-align:center;margin:0 0 20px">
          <a href="${frontendUrl}/login" style="display:inline-block;padding:12px 28px;background:#132e5e;color:#fff;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600">
            Log in to Stewardex
          </a>
        </div>
        <p style="margin:0;font-size:12px;line-height:18px;color:#94a3b8;text-align:center">
          This is a read-only account. Please change your password after logging in.
        </p>
      </div>
    `;
    await emailService.sendEmail({
      to: email,
      subject: `Auditor access: ${orgName}`,
      html,
    });
  } catch (emailErr) {
    const { logError: le } = await import('../utils/logger.js');
    le('Failed to send auditor invitation email', emailErr, { userId: newUser._id, orgId });
  }

  res.json({
    success: true,
    message: 'Auditor account created and invitation email sent.',
    data: {
      _id: newUser._id,
      email,
      firstName,
      lastName,
      status: 'active',
      is_auditor: true,
    },
  });
});
