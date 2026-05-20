/**
 * Expense Controller
 * 
 * Handles HTTP requests for expense management
 */

import { ExpenseService } from '../services/expenseService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { uploadToS3, getFileUrl as s3GetFileUrl } from '../services/s3Service.js';

export const createExpense = asyncHandler(async (req, res) => {
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
  const userId = req.user.userId;
  const expenseData = req.body;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.createExpense(expenseData, userId);

  res.status(201).json({
    success: true,
    data: expense
  });
});

export const submitExpense = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { expenseId } = req.params;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.submitExpense(expenseId, userId);

  res.json({
    success: true,
    data: expense
  });
});

export const getExpenses = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    submittedBy: req.query.submittedBy,
    startDate: req.query.startDate,
    endDate: req.query.endDate
  };

  const expenseService = new ExpenseService(orgId);
  const expenses = await expenseService.getExpenses(filters);

  // EXP-023 — derive per-row compliance flags so the list UI can show a
  // "missing invoice" chip even when historical/edge data slipped through
  // the creation-time validation.
  const data = (expenses || []).map((e) => {
    const obj = typeof e?.toObject === 'function' ? e.toObject() : { ...(e || {}) };
    obj.compliance_preview = computeExpenseComplianceFlags(obj);
    return obj;
  });

  res.json({
    success: true,
    data
  });
});

function computeExpenseComplianceFlags(e) {
  const flags = [];
  if (!e?.invoice_file || (typeof e.invoice_file === 'string' && !e.invoice_file.trim())) {
    flags.push({ key: 'missing_invoice', severity: 'warning', message: 'Invoice file is missing' });
  }
  if (typeof e?.amount === 'number' && e.amount <= 0) {
    flags.push({ key: 'invalid_amount', severity: 'error', message: 'Amount must be greater than zero' });
  }
  if (!e?.supplier_name && !e?.supplier_information) {
    flags.push({ key: 'no_supplier', severity: 'info', message: 'No supplier recorded' });
  }
  return flags;
}

export const getExpenseById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { expenseId } = req.params;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.getExpenseById(expenseId);

  const obj = expense && typeof expense.toObject === 'function' ? expense.toObject() : { ...(expense || {}) };
  if (obj && Object.keys(obj).length) {
    obj.compliance_preview = computeExpenseComplianceFlags(obj);
  }

  res.json({
    success: true,
    data: obj
  });
});

export const updateExpense = asyncHandler(async (req, res) => {
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
  const userId = req.user.userId;
  const { expenseId } = req.params;
  const updateData = req.body;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.updateExpense(expenseId, updateData, userId);

  res.json({
    success: true,
    data: expense
  });
});

export const deleteExpense = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { expenseId } = req.params;

  const expenseService = new ExpenseService(orgId);
  await expenseService.deleteExpense(expenseId, userId);

  res.json({
    success: true,
    message: 'Expense deleted successfully'
  });
});

export const cancelExpense = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { expenseId } = req.params;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.cancelExpense(expenseId, userId);

  res.json({
    success: true,
    data: expense
  });
});

export const assignExpense = asyncHandler(async (req, res) => {
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
  const userId = req.user.userId;
  const { expenseId } = req.params;
  const { assigned_to, payment_processor_id, payment_reviewer_id, payment_co_signatory_id } = req.body;

  const expenseService = new ExpenseService(orgId);
  const expense =
    payment_processor_id && payment_reviewer_id && payment_co_signatory_id
      ? await expenseService.assignPaymentTeam(
          expenseId,
          payment_processor_id,
          payment_reviewer_id,
          payment_co_signatory_id,
          userId
        )
      : await expenseService.assignExpense(expenseId, assigned_to, userId);

  res.json({
    success: true,
    data: expense
  });
});

export const submitPaymentsForReview = asyncHandler(async (req, res) => {
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
  const userId = req.user.userId;
  const { expenseId } = req.params;
  const payload = req.body;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.submitPaymentsForReview(expenseId, payload, userId);

  res.json({
    success: true,
    data: expense
  });
});

export const reviewPayments = asyncHandler(async (req, res) => {
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
  const userId = req.user.userId;
  const { expenseId } = req.params;
  const payload = req.body;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.reviewPayments(expenseId, payload, userId);

  res.json({
    success: true,
    data: expense
  });
});

export const submitPaymentProof = asyncHandler(async (req, res) => {
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
  const userId = req.user.userId;
  const { expenseId } = req.params;
  const paymentData = req.body;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.submitPaymentProof(expenseId, paymentData, userId);

  res.json({
    success: true,
    data: expense
  });
});

/**
 * Upload a file for an expense (invoice, evidence, payment proof)
 * Uploads to S3 and returns the S3 key
 */
export const uploadExpenseFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: { code: 'FILE_REQUIRED', message: 'File is required' }
    });
  }

  const orgId = req.orgId;
  const { key } = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'expenses'
  );

  res.json({
    success: true,
    data: {
      key,
      fileName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype
    }
  });
});

/**
 * Get a signed URL to view/download an expense file
 */
export const getExpenseFileUrl = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) {
    return res.status(400).json({
      success: false,
      error: { code: 'KEY_REQUIRED', message: 'File key is required' }
    });
  }

  const url = await s3GetFileUrl(key, 3600); // 1 hour expiry
  res.json({
    success: true,
    data: { url }
  });
});
