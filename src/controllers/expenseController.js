/**
 * Expense Controller
 * 
 * Handles HTTP requests for expense management
 */

import { ExpenseService } from '../services/expenseService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';

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
  const userId = req.user._id;
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
  const userId = req.user._id;
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

  res.json({
    success: true,
    data: expenses
  });
});

export const getExpenseById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { expenseId } = req.params;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.getExpenseById(expenseId);

  res.json({
    success: true,
    data: expense
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
  const userId = req.user._id;
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
  const userId = req.user._id;
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
  const userId = req.user._id;
  const { expenseId } = req.params;

  const expenseService = new ExpenseService(orgId);
  const expense = await expenseService.cancelExpense(expenseId, userId);

  res.json({
    success: true,
    data: expense
  });
});
