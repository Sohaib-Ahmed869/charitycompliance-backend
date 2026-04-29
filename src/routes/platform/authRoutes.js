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
  verifyOtp,
  sendOtp,
  refreshPermissions,
  enableMfa,
  disableMfa,
  loginAsDemoUser
} from '../../controllers/authController.js';
import { registerValidator, loginValidator, refreshTokenValidator, acceptInvitationValidator, forgotPasswordValidator, resetPasswordValidator, verifyOtpValidator, sendOtpValidator } from '../../validators/authValidators.js';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

router.post('/register', registerValidator, validate, register);
router.post('/login', loginValidator, validate, login);
router.post('/refresh', refreshTokenValidator, validate, refreshToken);

// OTP (MFA) - public, no auth required
router.post('/otp/verify', verifyOtpValidator, validate, verifyOtp);
router.post('/otp/send', sendOtpValidator, validate, sendOtp);

// Simple email-based MFA toggle for current user (requires auth + tenant)
router.post('/mfa/enable', authAndResolveTenant, enableMfa);
router.post('/mfa/disable', authAndResolveTenant, disableMfa);

// Password reset (public - no auth required)
router.post('/forgot-password', forgotPasswordValidator, validate, forgotPassword);
router.post('/reset-password', resetPasswordValidator, validate, resetPassword);

// Invitation routes (public - no auth required)
router.get('/invitation/:token', verifyInvitationToken);
router.post('/invitation/:token/accept', acceptInvitationValidator, validate, acceptInvitation);

// Runtime permission refresh for current user
router.get('/me/permissions', authAndResolveTenant, refreshPermissions);

// Demo Portal: log in as another user (no password). Service enforces that
// the caller's tenant matches DEMO_ORG_ID env var — disabled everywhere else.
router.post('/demo-login-as', authAndResolveTenant, loginAsDemoUser);

export default router;
