import speakeasy from 'speakeasy';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { issueMfaToken } from '../middleware/mfa.js';

export const setupTotp = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const tenantDb = await getTenantConnection(orgId);
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const secret = speakeasy.generateSecret({
    name: `CharityCompliance (${user.email})`,
    length: 20
  });

  // store secret but don't enable until confirmed
  await userRepo.update(userId, { mfa_secret: secret.base32, mfa_enabled: false });

  res.json({
    success: true,
    data: {
      secret: secret.base32,
      otpauth_url: secret.otpauth_url
    }
  });
});

export const enableTotp = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const { token } = req.body || {};
  if (!token) throw new AppError('TOTP code is required', 400, 'VALIDATION_ERROR');

  const tenantDb = await getTenantConnection(orgId);
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  if (!user.mfa_secret) throw new AppError('TOTP is not set up', 400, 'TOTP_NOT_SETUP');

  const ok = speakeasy.totp.verify({
    secret: user.mfa_secret,
    encoding: 'base32',
    token: String(token),
    window: 1
  });
  if (!ok) throw new AppError('Invalid code', 400, 'INVALID_TOTP');

  await userRepo.update(userId, { mfa_enabled: true });

  res.json({ success: true, data: { enabled: true } });
});

export const verifyTotpForScope = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const { token, scope } = req.body || {};
  if (!token) throw new AppError('TOTP code is required', 400, 'VALIDATION_ERROR');
  if (!scope) throw new AppError('Scope is required', 400, 'VALIDATION_ERROR');

  const tenantDb = await getTenantConnection(orgId);
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  if (!user.mfa_enabled || !user.mfa_secret) throw new AppError('TOTP is not enabled', 400, 'TOTP_NOT_ENABLED');

  const ok = speakeasy.totp.verify({
    secret: user.mfa_secret,
    encoding: 'base32',
    token: String(token),
    window: 1
  });
  if (!ok) throw new AppError('Invalid code', 400, 'INVALID_TOTP');

  const mfaToken = issueMfaToken({ userId, orgId, scope }, 600);
  res.json({ success: true, data: { mfa_token: mfaToken, expires_in: 600 } });
});

