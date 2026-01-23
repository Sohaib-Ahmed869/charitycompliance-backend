/**
 * Expense Routes
 * 
 * API routes for expense management
 */

import express from 'express';
import * as expenseController from '../../controllers/expenseController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All expense routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Create expense
router.post(
  '/',
  [
    body('amount')
      .isFloat({ min: 0 })
      .withMessage('Amount must be a positive number'),
    body('category')
      .trim()
      .notEmpty()
      .withMessage('Category is required'),
    body('description')
      .trim()
      .notEmpty()
      .withMessage('Description is required'),
    body('invoice_file')
      .trim()
      .notEmpty()
      .withMessage('Invoice file is required'),
    body('status')
      .optional()
      .isIn(['draft', 'pending'])
      .withMessage('Status must be draft or pending')
  ],
  validate,
  expenseController.createExpense
);

// Get all expenses
router.get(
  '/',
  [
    query('status')
      .optional()
      .isIn(['draft', 'pending', 'approved', 'rejected', 'paid', 'cancelled'])
      .withMessage('Invalid status'),
    query('submittedBy')
      .optional()
      .isMongoId()
      .withMessage('Invalid submittedBy ID'),
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Invalid start date format'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('Invalid end date format')
  ],
  validate,
  expenseController.getExpenses
);

// Get expense by ID
router.get(
  '/:expenseId',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID')
  ],
  validate,
  expenseController.getExpenseById
);

// Update expense
router.put(
  '/:expenseId',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID'),
    body('amount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Amount must be a positive number'),
    body('category')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Category cannot be empty'),
    body('description')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Description cannot be empty')
  ],
  validate,
  expenseController.updateExpense
);

// Submit expense for approval
router.post(
  '/:expenseId/submit',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID')
  ],
  validate,
  expenseController.submitExpense
);

// Cancel expense
router.post(
  '/:expenseId/cancel',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID')
  ],
  validate,
  expenseController.cancelExpense
);

// Delete expense
router.delete(
  '/:expenseId',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID')
  ],
  validate,
  expenseController.deleteExpense
);

export default router;
