/**
 * Onboarding Routes
 * 
 * API routes for onboarding flow
 */

import express from 'express';
import * as onboardingController from '../../controllers/onboardingController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All onboarding routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get onboarding progress
router.get('/progress', onboardingController.getProgress);

// Verify ABN (Step 1)
router.post(
  '/verify-abn',
  [
    body('abn')
      .trim()
      .matches(/^\d{11}$/)
      .withMessage('ABN must be 11 digits')
  ],
  validate,
  onboardingController.verifyABN
);

// Update specific step
router.put(
  '/step/:stepNumber',
  [
    param('stepNumber')
      .isInt({ min: 1, max: 16 })
      .withMessage('Step number must be between 1 and 16')
  ],
  validate,
  onboardingController.updateStep
);

// Complete onboarding
router.post('/complete', onboardingController.completeOnboarding);

export default router;
