/**
 * Authentication Controller
 * 
 * Handles HTTP requests for authentication endpoints
 */

import authService from '../services/authService.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';

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
