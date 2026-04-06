/**
 * Financial Controls Routes
 * 
 * API routes for financial controls
 */

import express from 'express';
import * as financialControlsController from '../../controllers/financialControlsController.js';
import { body } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get financial controls
router.get(
  '/',
  validate,
  financialControlsController.getFinancialControls
);

// Update financial controls
router.put(
  '/',
  [
    body('estimated_annual_revenue')
      .isFloat({ min: 0 })
      .withMessage('Estimated annual revenue must be a positive number'),
    body('financial_year_end_date')
      .notEmpty()
      .withMessage('Financial year end date is required')
      .isISO8601()
      .withMessage('Financial year end date must be a valid date'),
    body('current_revenue_sources')
      .trim()
      .notEmpty()
      .withMessage('Current revenue sources is required'),
    body('intended_revenue_sources')
      .trim()
      .notEmpty()
      .withMessage('Intended revenue sources is required'),
    body('uses_different_reporting_period')
      .isIn(['yes', 'no'])
      .withMessage('Invalid value for uses different reporting period'),
    body('reporting_period_start_date')
      .if(body('uses_different_reporting_period').equals('yes'))
      .notEmpty()
      .withMessage('Reporting period start date is required when using a different reporting period')
      .bail()
      .isISO8601()
      .withMessage('Reporting period start date must be a valid date'),
    body('reporting_period_end_date')
      .if(body('uses_different_reporting_period').equals('yes'))
      .notEmpty()
      .withMessage('Reporting period end date is required when using a different reporting period')
      .bail()
      .isISO8601()
      .withMessage('Reporting period end date must be a valid date'),
    body('reason_for_different_period')
      .optional()
      .trim(),
    body('education_id')
      .optional()
      .trim()
  ],
  validate,
  financialControlsController.updateFinancialControls
);

export default router;
