/**
 * Activity Routes
 * 
 * API routes for operating activities
 */

import express from 'express';
import * as activityController from '../../controllers/activityController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get all activities
router.get(
  '/',
  [
    query('includeInactive')
      .optional()
      .isBoolean()
      .withMessage('includeInactive must be a boolean')
  ],
  validate,
  activityController.getActivities
);

// Get activity by ID
router.get(
  '/:activityId',
  [
    param('activityId')
      .isMongoId()
      .withMessage('Invalid activity ID')
  ],
  validate,
  activityController.getActivityById
);

// Create activity
router.post(
  '/',
  [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Activity name is required'),
    body('description')
      .trim()
      .notEmpty()
      .withMessage('Activity description is required'),
    body('link_to_charitable_purpose')
      .trim()
      .notEmpty()
      .withMessage('Link to charitable purpose is required'),
    body('beneficiary_group')
      .trim()
      .notEmpty()
      .withMessage('Beneficiary group is required'),
    body('beneficiary_selection_criteria')
      .trim()
      .notEmpty()
      .withMessage('Beneficiary selection criteria is required'),
    body('estimated_time_allocation')
      .isFloat({ min: 0, max: 100 })
      .withMessage('Estimated time allocation must be between 0 and 100'),
    body('estimated_money_allocation')
      .isFloat({ min: 0 })
      .withMessage('Estimated money allocation must be a positive number'),
    body('operating_locations')
      .isArray({ min: 1 })
      .withMessage('At least one operating location is required'),
    body('operating_locations.*')
      .trim()
      .notEmpty()
      .withMessage('Operating location cannot be empty'),
    body('overseas_details')
      .optional()
      .trim()
  ],
  validate,
  activityController.createActivity
);

// Update activity
router.put(
  '/:activityId',
  [
    param('activityId')
      .isMongoId()
      .withMessage('Invalid activity ID'),
    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Activity name cannot be empty'),
    body('estimated_time_allocation')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Estimated time allocation must be between 0 and 100'),
    body('estimated_money_allocation')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Estimated money allocation must be a positive number'),
    body('status')
      .optional()
      .isIn(['active', 'inactive', 'completed'])
      .withMessage('Invalid status')
  ],
  validate,
  activityController.updateActivity
);

// Delete activity
router.delete(
  '/:activityId',
  [
    param('activityId')
      .isMongoId()
      .withMessage('Invalid activity ID')
  ],
  validate,
  activityController.deleteActivity
);

export default router;
