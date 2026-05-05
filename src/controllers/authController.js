/**
 * Authentication Controller
 * 
 * Handles HTTP requests for authentication endpoints
 */

import authService, { getPositionPermissionsForUser } from '../services/authService.js';
import { buildAuditorPermissions } from '../utils/auditorAccess.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';

export const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);

  res.status(201).json({
    success: true,
    data: result
  });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);

  res.json({
    success: true,
    data: result
  });
});

export const refreshToken = asyncHandler(async (req, res) => {
  // TODO: Implement refresh token logic
  throw new AppError('Not implemented', 501, 'NOT_IMPLEMENTED');
});

export const verifyInvitationToken = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const result = await authService.verifyInvitationToken(token);

  res.json({
    success: true,
    data: result
  });
});

export const acceptInvitation = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  const result = await authService.acceptInvitation(token, password);

  res.json({
    success: true,
    data: result
  });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  await authService.forgotPassword(email);

  res.json({
    success: true,
    message: 'If an account exists with this email, you will receive a password reset link shortly.'
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  await authService.resetPassword(token, password);

  res.json({
    success: true,
    message: 'Your password has been reset. You can now log in with your new password.'
  });
});

// Validate a password-reset token without consuming it. Called from the
// reset-password page on load so we can show "Invalid Reset Link" UI when
// the token is missing, tampered, or expired — before the form is rendered.
export const verifyResetToken = asyncHandler(async (req, res) => {
  const token = req.params.token || req.query.token;
  await authService.verifyResetToken(token);
  res.json({ success: true, data: { valid: true } });
});

export const verifyOtp = asyncHandler(async (req, res) => {
  const { userId, code, orgId } = req.body;
  const result = await authService.completeLoginWithOtp(orgId, userId, code);

  res.json({
    success: true,
    data: result
  });
});

export const sendOtp = asyncHandler(async (req, res) => {
  const { userId, orgId } = req.body;
  await authService.resendOtp(orgId, userId);

  res.json({
    success: true,
    message: 'Verification code sent to your email'
  });
});

export const enableMfa = asyncHandler(async (req, res) => {
  const userId = req.user?.userId;
  const orgId = req.orgId || req.user?.orgId;

  if (!userId || !orgId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const tenantDb = await getTenantConnection(orgId);
  await authService.enableMfa(tenantDb, userId);

  res.json({
    success: true,
    message: 'Multi-factor authentication enabled'
  });
});

export const disableMfa = asyncHandler(async (req, res) => {
  const userId = req.user?.userId;
  const orgId = req.orgId || req.user?.orgId;

  if (!userId || !orgId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const tenantDb = await getTenantConnection(orgId);
  await authService.disableMfa(tenantDb, userId);

  res.json({
    success: true,
    message: 'Multi-factor authentication disabled'
  });
});

/**
 * Runtime permission refresh for currently authenticated user.
 * Returns the latest effective permissions based on the user's positions.
 */
export const refreshPermissions = asyncHandler(async (req, res) => {
  const userId = req.user?.userId;
  const orgId = req.orgId || req.user?.orgId;

  if (!userId || !orgId) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  const tenantDb = await getTenantConnection(orgId);

  // Resolve organisation to get its _id (required by BoardMember/position helpers)
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  let basePermissions;
  if (req.user?.roles?.includes('admin')) {
    basePermissions = ['*:*'];
  } else if (req.user?.isAuditor) {
    basePermissions = buildAuditorPermissions();
  } else {
    const positionPermissions = await getPositionPermissionsForUser(tenantDb, userId, org._id);
    if (positionPermissions.length > 0) {
      basePermissions = ['read:own', 'write:own', ...positionPermissions];
    } else {
      basePermissions = ['read:own', 'write:own'];
    }
  }

  res.json({
    success: true,
    data: {
      permissions: Array.from(new Set(basePermissions))
    }
  });
});

/**
 * Demo Portal: log in as another user without a password. Hard-gated to the
 * tenant matching DEMO_ORG_ID env var. Returns a fresh JWT for the target
 * user — frontend swaps the auth state and reloads, so the rest of the app
 * sees a normal session under the new user with no impersonation plumbing.
 */
export const loginAsDemoUser = asyncHandler(async (req, res) => {
  const { targetUserId } = req.body || {};
  const result = await authService.loginAsDemoUser(req.orgId, targetUserId);
  res.json({ success: true, data: result });
});
