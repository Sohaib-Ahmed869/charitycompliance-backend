/**
 * User Controller
 * Team member listing for attendees
 */

import crypto from 'crypto';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { getFileUrl } from '../services/s3Service.js';
import emailService, { buildEmailTemplate } from '../services/emailService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';

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

  const mapped = await Promise.all(users.map(async (user) => {
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
      avatar,
      isAuditor: user?.is_auditor === true,
      isVolunteer: boardMember?.is_volunteer === true,
      isBoardMember: boardMember?.is_board_member === true,
      isOrgOwner: user?.is_org_owner === true,
      department: boardMember?.department || ''
    };
  }));
  const data = mapped.filter((u) => !u.isAuditor && !u.isVolunteer);

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

  // Check if user already exists with this email. findByEmail is an instance
  // method on UserRepository — needs a tenant-bound instance to resolve the
  // tenant's User model.
  const userRepo = new UserRepository(tenantDb);
  const existingUser = await userRepo.findByEmail(email);
  if (existingUser) {
    throw new AppError('User with this email already exists', 409, 'USER_EXISTS');
  }

  // Generate a one-time invitation token. The same token is what auditors
  // click in the email; the frontend's /invitation/:token route hits
  // verifyInvitationToken which now also checks auditor_invites.
  const invitationToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // Expires in 7 days

  const auditorInvite = {
    email,
    firstName,
    lastName,
    invitedAt: new Date(),
    invitedBy: userId,
    status: 'pending',
    role: 'auditor',
    invitation_token: invitationToken,
    invitation_expires_at: expiresAt,
    invitation_status: 'pending'
  };

  const result = await tenantDb.collection('auditor_invites').insertOne(auditorInvite);

  // Send the invitation email — wrapped in try/catch so a transport failure
  // doesn't roll back the invite record (the org owner can resend later).
  let emailSent = false;
  try {
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    const orgName = org?.trading_name || org?.name || 'your organisation';
    const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
    const inviteLink = `${baseUrl}/invitation/${invitationToken}`;
    const recipientName = `${firstName || ''} ${lastName || ''}`.trim() || 'Auditor';
    const inviterName = req.user?.firstName
      ? `${req.user.firstName} ${req.user.lastName || ''}`.trim()
      : null;

    const html = buildEmailTemplate({
      heading: 'You\'re Invited as an Auditor',
      bodyHtml: `
        <p style="margin: 0 0 12px 0; font-size: 13px; line-height: 1.6; color: #334155; text-align: center; max-width: 520px;">Hi ${recipientName},</p>
        <p style="margin: 0 0 12px 0; font-size: 13px; line-height: 1.6; color: #334155; text-align: center; max-width: 520px;">${inviterName ? `${inviterName} has invited you` : 'You have been invited'} to audit <strong>${orgName}</strong> on Stewardex.</p>
        <p style="margin: 0 0 12px 0; font-size: 13px; line-height: 1.6; color: #334155; text-align: center; max-width: 520px;">Auditors get read-only access across every governance module — perfect for end-of-year reviews, ACNC compliance audits, and board-cycle check-ins. You can read everything; nothing you do can change the underlying records.</p>
        <p style="margin: 0; font-size: 13px; line-height: 1.6; color: #334155; text-align: center; max-width: 520px;">Click the button below to set your password and start.</p>
      `,
      buttonText: 'Accept Auditor Invitation',
      buttonLink: inviteLink,
      infoBoxLines: [
        'You\'ll have read-only access — every mutating action is blocked for auditor accounts.',
        'This invitation expires in 7 days.',
        'If you didn\'t expect this email, you can safely ignore it.'
      ]
    });

    await emailService.sendEmail({
      to: email,
      subject: `Auditor invitation — ${orgName}`,
      html
    });

    await tenantDb.collection('auditor_invites').updateOne(
      { _id: result.insertedId },
      { $set: { invitation_status: 'sent', invitation_sent_at: new Date() } }
    );
    emailSent = true;
    logInfo('Auditor invitation email sent', { orgId, email, inviteId: result.insertedId });
  } catch (err) {
    logError('Auditor invitation email failed', { orgId, email, error: err?.message });
  }

  res.json({
    success: true,
    data: {
      _id: result.insertedId,
      email,
      firstName,
      lastName,
      status: emailSent ? 'sent' : 'pending',
      invitedAt: auditorInvite.invitedAt,
      invitation_expires_at: expiresAt
    },
    message: emailSent
      ? 'Auditor invitation sent.'
      : 'Auditor invite recorded but the email could not be sent. Resend from the auditor list.'
  });
});
