/**
 * Authentication Routes
 */

import express from 'express';
import {
  register,
  login,
  refreshToken,
  verifyInvitationToken,
  acceptInvitation,
  forgotPassword,
  resetPassword,
  changePassword,
  verifyResetToken,
  verifyOtp,
  sendOtp,
  refreshPermissions,
  enableMfa,
  disableMfa,
  loginAsDemoUser
} from '../../controllers/authController.js';
import { registerValidator, loginValidator, refreshTokenValidator, acceptInvitationValidator, forgotPasswordValidator, resetPasswordValidator, changePasswordValidator, verifyOtpValidator, sendOtpValidator } from '../../validators/authValidators.js';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
// SECURITY (API-003): public auth endpoints are the brute-force / abuse surface,
// so they carry a per-IP rate limit (the global limiter stays off to avoid
// spurious 429s on the dashboard's parallel fan-out). authLimiter (5 failed /
// 15 min, skips successes) throttles credential + OTP-code guessing;
// passwordResetLimiter (10 / 15 min, counts all) throttles reset / OTP-send spam.
import { authLimiter, passwordResetLimiter } from '../../middleware/rateLimiter.js';

const router = express.Router();

router.post('/register', authLimiter, registerValidator, validate, register);
router.post('/login', authLimiter, loginValidator, validate, login);
router.post('/refresh', refreshTokenValidator, validate, refreshToken);

// OTP (MFA) - public, no auth required
router.post('/otp/verify', authLimiter, verifyOtpValidator, validate, verifyOtp);
router.post('/otp/send', passwordResetLimiter, sendOtpValidator, validate, sendOtp);

// Simple email-based MFA toggle for current user (requires auth + tenant)
router.post('/mfa/enable', authAndResolveTenant, enableMfa);
router.post('/mfa/disable', authAndResolveTenant, disableMfa);

// Password reset (public - no auth required)
router.post('/forgot-password', passwordResetLimiter, forgotPasswordValidator, validate, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPasswordValidator, validate, resetPassword);
router.get('/reset-password/verify/:token', verifyResetToken);

// AUTH-008: authenticated self-service change (requires the current password).
router.post('/change-password', authAndResolveTenant, changePasswordValidator, validate, changePassword);

// Invitation routes (public - no auth required)
router.get('/invitation/:token', verifyInvitationToken);
router.post('/invitation/:token/accept', passwordResetLimiter, acceptInvitationValidator, validate, acceptInvitation);

// Runtime permission refresh for current user
router.get('/me/permissions', authAndResolveTenant, refreshPermissions);

// Demo Portal: log in as another user (no password). Service enforces that
// the caller's tenant matches DEMO_ORG_ID env var — disabled everywhere else.
router.post('/demo-login-as', authAndResolveTenant, loginAsDemoUser);

export default router;
