/**
 * Onboarding Controller
 * 
 * Handles HTTP requests for onboarding flow
 */

import { OnboardingService } from '../services/onboardingService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';

export const getProgress = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const onboardingService = new OnboardingService(orgId);
  
  const progress = await onboardingService.getProgress();
  
  res.json({
    success: true,
    data: progress
  });
});

export const updateStep = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const { stepNumber } = req.params;
  const stepData = req.body;

  const onboardingService = new OnboardingService(orgId);
  const result = await onboardingService.updateStep(parseInt(stepNumber), stepData);

  res.json({
    success: true,
    data: result
  });
});

export const verifyABN = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid ABN format',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const { abn } = req.body;

  const onboardingService = new OnboardingService(orgId);
  const result = await onboardingService.updateStep(1, { abn });

  res.json({
    success: true,
    data: result.data
  });
});

export const completeOnboarding = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const onboardingService = new OnboardingService(orgId);
  
  await onboardingService.updateStep(16, req.body);
  
  res.json({
    success: true,
    message: 'Onboarding completed successfully'
  });
});
