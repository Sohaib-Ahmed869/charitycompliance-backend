/**
 * Authentication Validators
 * 
 * Validation schemas for auth endpoints using express-validator
 */

import { body } from 'express-validator';
import config from '../config/index.js';

export const registerValidator = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  
  body('password')
    .isLength({ min: config.password.minLength })
    .withMessage(`Password must be at least ${config.password.minLength} characters`)
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must contain at least one special character'),
  
  body('organizationName')
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Organisation name must be between 2 and 80 characters (used for your account identifier)'),
  
  body('firstName')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('First name is required'),
  
  body('lastName')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Last name is required')
];

export const loginValidator = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  
  body('password')
    .notEmpty()
    .withMessage('Password is required')
];

export const refreshTokenValidator = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required')
];

export const acceptInvitationValidator = [
  body('password')
    .isLength({ min: config.password.minLength })
    .withMessage(`Password must be at least ${config.password.minLength} characters`)
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must contain at least one special character')
];

export const forgotPasswordValidator = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required')
];

export const resetPasswordValidator = [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required'),
  body('password')
    .isLength({ min: config.password.minLength })
    .withMessage(`Password must be at least ${config.password.minLength} characters`)
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must contain at least one special character')
];

export const verifyOtpValidator = [
  body('userId').notEmpty().withMessage('User ID is required'),
  // Length range covers the dev bypass (4-digit `1743`) and the
  // standard 6-digit production code. Restrict to 6/6 when the bypass
  // is removed.
  body('code').isLength({ min: 4, max: 6 }).isNumeric().withMessage('Code must be 4–6 digits'),
  body('orgId').notEmpty().withMessage('Organization ID is required')
];

export const sendOtpValidator = [
  body('userId').notEmpty().withMessage('User ID is required'),
  body('orgId').notEmpty().withMessage('Organization ID is required')
];

// AUTH-008: authenticated self-service password change requires the CURRENT
// password, and the new password must meet the same policy as reset/register.
export const changePasswordValidator = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: config.password.minLength })
    .withMessage(`Password must be at least ${config.password.minLength} characters`)
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must contain at least one special character')
];
