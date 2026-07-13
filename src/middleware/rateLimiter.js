/**
 * Rate Limiting Middleware
 * 
 * Additional rate limiting for specific routes if needed.
 */

import rateLimit from 'express-rate-limit';

/**
 * Strict rate limiter for authentication endpoints
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: {
    success: false,
    error: 'Too many authentication attempts, please try again later.'
  },
  skipSuccessfulRequests: true
});

/**
 * Limiter for public "trigger an action" auth endpoints — forgot/reset password
 * and OTP send. Unlike authLimiter these count EVERY request (no
 * skipSuccessfulRequests), because forgot-password intentionally always returns
 * 200 (anti-enumeration), so success-skipping would leave it unthrottled and
 * open to reset-email spam / token brute-force / operator-injection probing.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    error: 'Too many requests, please try again later.'
  }
});

/**
 * Rate limiter for file uploads
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
  message: {
    success: false,
    error: 'Too many file uploads, please try again later.'
  }
});

/**
 * Rate limiter for API endpoints
 */
export const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    success: false,
    error: 'Too many requests, please try again later.'
  }
});

export default {
  authLimiter,
  passwordResetLimiter,
  uploadLimiter,
  apiLimiter
};
