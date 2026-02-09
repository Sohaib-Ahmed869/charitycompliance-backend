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

// Get departments (for Step 2)
router.get('/departments', onboardingController.getDepartments);

// Delete department (when user removes in Step 2)
router.delete(
  '/departments/:departmentId',
  [param('departmentId').isMongoId().withMessage('Valid department ID is required')],
  validate,
  onboardingController.deleteDepartment
);

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

// Update profile completion step (for dashboard)
router.put(
  '/profile-step',
  [
    body('stepKey')
      .isIn(['documents_complete', 'responsible_people_complete', 'activities_complete', 'finances_complete', 'financial_controls_complete', 'governance_complete', 'declaration_complete'])
      .withMessage('Invalid step key'),
    body('completed')
      .isBoolean()
      .withMessage('Completed must be a boolean')
  ],
  validate,
  onboardingController.updateProfileCompletionStep
);

export default router;
