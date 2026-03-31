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
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

// All expense routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Upload expense file to S3
router.post(
  '/upload',
  uploadSingle,
  handleUploadError,
  expenseController.uploadExpenseFile
);

// Get signed URL for an expense file
router.get(
  '/file-url',
  expenseController.getExpenseFileUrl
);

// Create expense
router.post(
  '/',
  [
    body('expense_name')
      .trim()
      .notEmpty()
      .withMessage('Expense name is required'),
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
    body('supplier_name')
      .optional()
      .trim(),
    body('supplier_information')
      .optional()
      .trim(),
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
    body('expense_name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Expense name cannot be empty'),
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
    ,
    body('supplier_name')
      .optional()
      .trim(),
    body('supplier_information')
      .optional()
      .trim()
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

// Assign expense to a member for payment
router.post(
  '/:expenseId/assign',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID'),
    body('assigned_to')
      .optional()
      .isMongoId()
      .withMessage('Invalid user ID for assignment'),
    body('payment_processor_id')
      .optional()
      .isMongoId()
      .withMessage('Invalid processor user ID'),
    body('payment_reviewer_id')
      .optional()
      .isMongoId()
      .withMessage('Invalid reviewer user ID'),
    body()
      .custom((value) => {
        const hasLegacy = !!value?.assigned_to;
        const hasTeam = !!value?.payment_processor_id && !!value?.payment_reviewer_id;
        if (!hasLegacy && !hasTeam) {
          throw new Error('Either assigned_to or both payment_processor_id and payment_reviewer_id are required');
        }
        return true;
      })
  ],
  validate,
  expenseController.assignExpense
);

// Processor submits one or more payments for review
router.post(
  '/:expenseId/payments/submit',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID'),
    body('payments')
      .isArray({ min: 1 })
      .withMessage('payments must be a non-empty array'),
    body('payments.*.payment_method')
      .trim()
      .notEmpty()
      .withMessage('Payment method is required')
      .isString()
      .withMessage('Invalid payment method'),
    body('payments.*.payment_proof')
      .trim()
      .notEmpty()
      .withMessage('Payment proof file is required'),
    body('payments.*.payment_date')
      .optional()
      .isISO8601()
      .withMessage('Invalid payment date format'),
    body('payments.*.payment_reference')
      .optional()
      .trim(),
    body('payments.*.payment_notes')
      .optional()
      .trim(),
    body('payments.*.amount')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Payment amount must be a positive number')
  ],
  validate,
  expenseController.submitPaymentsForReview
);

// Reviewer accepts (or requests changes) for submitted payments
router.post(
  '/:expenseId/payments/review',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID'),
    body('action')
      .optional()
      .isIn(['accept', 'request_changes'])
      .withMessage('Invalid action'),
    body('review_notes')
      .optional()
      .trim(),
    body('signature_data')
      .optional()
      .isString()
      .withMessage('Invalid signature_data')
  ],
  validate,
  expenseController.reviewPayments
);

// Submit payment proof
router.post(
  '/:expenseId/payment-proof',
  [
    param('expenseId')
      .isMongoId()
      .withMessage('Invalid expense ID'),
    body('payment_method')
      .trim()
      .notEmpty()
      .withMessage('Payment method is required')
      .isString()
      .withMessage('Invalid payment method'),
    body('payment_proof')
      .trim()
      .notEmpty()
      .withMessage('Payment proof file is required'),
    body('payment_date')
      .optional()
      .isISO8601()
      .withMessage('Invalid payment date format'),
    body('payment_reference')
      .optional()
      .trim(),
    body('payment_notes')
      .optional()
      .trim()
  ],
  validate,
  expenseController.submitPaymentProof
);

export default router;
