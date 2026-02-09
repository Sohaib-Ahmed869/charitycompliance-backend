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

export const getDepartments = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const onboardingService = new OnboardingService(orgId);
  
  const departments = await onboardingService.getDepartments();
  
  res.json({
    success: true,
    data: departments
  });
});

export const deleteDepartment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { departmentId } = req.params;
  const onboardingService = new OnboardingService(orgId);
  
  await onboardingService.deleteDepartment(departmentId);
  
  res.json({
    success: true,
    message: 'Department deleted'
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
  
  // Step 5 (Review) already handles marking initial onboarding as complete
  // This endpoint can be used as an alternative way to complete onboarding
  await onboardingService.updateStep(5, req.body);
  
  res.json({
    success: true,
    message: 'Onboarding completed successfully'
  });
});

export const updateProfileCompletionStep = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { stepKey, completed } = req.body;
  
  // Validate stepKey
  const validSteps = [
    'documents_complete',
    'responsible_people_complete',
    'activities_complete',
    'finances_complete',
    'financial_controls_complete',
    'governance_complete',
    'declaration_complete'
  ];
  
  if (!validSteps.includes(stepKey)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_STEP',
        message: `Invalid step key. Must be one of: ${validSteps.join(', ')}`
      }
    });
  }
  
  const onboardingService = new OnboardingService(orgId);
  const result = await onboardingService.updateProfileCompletionStep(stepKey, completed);
  
  res.json({
    success: true,
    data: result
  });
});
