/**
 * User Controller
 * Team member listing for attendees
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
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
import { maskEmail } from '../utils/maskPii.js';

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
    logInfo('Auditor invitation email sent', { orgId, email: maskEmail(email), inviteId: result.insertedId });
  } catch (err) {
    logError('Auditor invitation email failed', { orgId, email: maskEmail(email), error: err?.message });
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

/**
 * List external auditors (invited + accepted), with live access status.
 */
export const listAuditors = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const invites = await tenantDb.collection('auditor_invites').find({}).sort({ invitedAt: -1 }).toArray();
  const userRepo = new UserRepository(tenantDb);

  const out = [];
  for (const inv of invites) {
    let userStatus = null;
    const userId = inv.user_id || null;
    if (userId) {
      try { const u = await userRepo.findById(userId); userStatus = u?.status || null; } catch { /* ignore */ }
    }
    // Display status: an accepted auditor whose user account is no longer
    // active has effectively been revoked.
    let status = inv.invitation_status || inv.status || 'pending';
    if (status === 'accepted' && userStatus && userStatus !== 'active') status = 'revoked';
    out.push({
      _id: inv._id,
      email: inv.email,
      firstName: inv.firstName || '',
      lastName: inv.lastName || '',
      status,
      user_id: userId,
      user_status: userStatus,
      invitedAt: inv.invitedAt,
      invitation_expires_at: inv.invitation_expires_at || null,
      accepted_at: inv.invitation_accepted_at || null,
      revoked_at: inv.revoked_at || null
    });
  }
  res.json({ success: true, data: out });
});

/**
 * Offboard / revoke an external auditor: deactivate their user account (if the
 * invite was accepted) and mark the invite revoked. Logged to access_change_logs.
 */
export const revokeAuditor = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const actorId = req.user?.userId;
  const { inviteId } = req.params;
  const tenantDb = await getTenantConnection(orgId);

  let _id;
  try { _id = new mongoose.Types.ObjectId(inviteId); } catch { throw new AppError('Invalid auditor id', 400, 'INVALID_ID'); }
  const invite = await tenantDb.collection('auditor_invites').findOne({ _id });
  if (!invite) throw new AppError('Auditor invite not found', 404, 'NOT_FOUND');

  // Deactivate the auditor's user account if they accepted.
  const userRepo = new UserRepository(tenantDb);
  let user = null;
  if (invite.user_id) {
    try { user = await userRepo.findById(invite.user_id); } catch { /* ignore */ }
  }
  if (!user && invite.email) {
    try { user = await userRepo.findByEmail(invite.email); } catch { /* ignore */ }
  }
  if (user && user.is_auditor) {
    await userRepo.update(user._id, {
      status: 'inactive', locked: true, locked_until: null, mfa_enabled: false, mfa_secret: null
    });
  }

  await tenantDb.collection('auditor_invites').updateOne(
    { _id },
    { $set: { status: 'revoked', invitation_status: 'revoked', invitation_token: null, revoked_at: new Date(), revoked_by: actorId || null } }
  );

  // Access-change audit (same collection the audit trail reads).
  try {
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    await tenantDb.collection('access_change_logs').insertOne({
      org_id: org?._id || null,
      user_id: user?._id || null,
      changed_by: actorId || null,
      action: 'auditor_offboarded',
      module: 'offboarding',
      details: { email: invite.email, access_revoked: !!user, reason: 'External auditor offboarded' },
      created_at: new Date()
    });
  } catch (e) {
    logError('Auditor revoke audit log failed', { orgId, error: e?.message });
  }

  logInfo('Auditor revoked', { orgId, inviteId, userDeactivated: !!(user && user.is_auditor) });
  res.json({ success: true, message: 'Auditor access revoked.' });
});
