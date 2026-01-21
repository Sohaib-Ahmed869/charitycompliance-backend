/**
 * Authentication Controller
 * 
 * Handles HTTP requests for authentication endpoints
 */

import authService from '../services/authService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

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
