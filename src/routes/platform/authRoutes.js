/**
 * Authentication Routes
 */

import express from 'express';
import { register, login, refreshToken, verifyInvitationToken, acceptInvitation, forgotPassword, resetPassword, verifyOtp, sendOtp } from '../../controllers/authController.js';
import { registerValidator, loginValidator, refreshTokenValidator, acceptInvitationValidator, forgotPasswordValidator, resetPasswordValidator, verifyOtpValidator, sendOtpValidator } from '../../validators/authValidators.js';
import { validate } from '../../middleware/validation.js';

const router = express.Router();

router.post('/register', registerValidator, validate, register);
router.post('/login', loginValidator, validate, login);
router.post('/refresh', refreshTokenValidator, validate, refreshToken);

// OTP (MFA) - public, no auth required
router.post('/otp/verify', verifyOtpValidator, validate, verifyOtp);
router.post('/otp/send', sendOtpValidator, validate, sendOtp);

// Password reset (public - no auth required)
router.post('/forgot-password', forgotPasswordValidator, validate, forgotPassword);
router.post('/reset-password', resetPasswordValidator, validate, resetPassword);

// Invitation routes (public - no auth required)
router.get('/invitation/:token', verifyInvitationToken);
router.post('/invitation/:token/accept', acceptInvitationValidator, validate, acceptInvitation);

export default router;
