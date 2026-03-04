/**
 * Expense Service
 * 
 * Business logic for expense/invoice management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';

export class ExpenseService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /**
   * Create a new expense
   */
  async createExpense(expenseData, submittedBy) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    // Validate against project funding if project is specified
    if (expenseData.project_id) {
      const ProjectRegister = tenantDb.model('ProjectRegister');
      const FundingAgreement = tenantDb.model('FundingAgreement');

      // Fetch project
      const project = await ProjectRegister.findById(expenseData.project_id);
      if (!project) {
        throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
      }

      // Check if project has a funding agreement
      if (project.agreement_id) {
        // Fetch funding agreement
        const agreement = await FundingAgreement.findById(project.agreement_id);
        if (agreement && agreement.total_amount) {
          // Calculate already used funds for this project (approved and paid expenses only)
          const usedFunds = await expenseRepo.getProjectUtilization(expenseData.project_id);
          const availableBalance = agreement.total_amount - usedFunds;

          // Check if new expense exceeds available balance
          if (expenseData.amount > availableBalance) {
            throw new AppError(
              `Expense amount ($${expenseData.amount}) exceeds available balance ($${availableBalance}). Total budget: $${agreement.total_amount}, Already used: $${usedFunds}`,
              400,
              'INSUFFICIENT_FUNDING'
            );
          }
        }
      }
    }

    const expense = await expenseRepo.create({
      org_id: this.orgId,
      submitted_by: submittedBy,
      expense_name: expenseData.expense_name,
      amount: expenseData.amount,
      category: expenseData.category,
      description: expenseData.description,
      invoice_file: expenseData.invoice_file,
      invoice_file_name: expenseData.invoice_file_name,
      invoice_date: expenseData.invoice_date,
      vendor_name: expenseData.vendor_name,
      vendor_email: expenseData.vendor_email,
      project_id: expenseData.project_id,
      funding_agreement_id: expenseData.funding_agreement_id,
      status: expenseData.status || 'draft',
      is_asset_purchase: expenseData.is_asset_purchase || false,
      asset_details: expenseData.asset_details || {},
      metadata: expenseData.metadata || {}
    });

    logInfo('Expense created', { expenseId: expense._id, submittedBy });

    // If status is not draft, create approval request
    if (expense.status !== 'draft') {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      await workflowService.createExpenseApprovalRequest(expense._id, submittedBy);
    }

    return expense;
  }

  /**
   * Submit expense for approval
   */
  async submitExpense(expenseId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    if (expense.submitted_by.toString() !== submittedBy.toString()) {
      throw new AppError('You can only submit your own expenses', 403, 'UNAUTHORIZED');
    }

    if (expense.status !== 'draft') {
      throw new AppError(`Expense is already ${expense.status}`, 400, 'INVALID_STATUS');
    }

    // Update status to pending
    await expenseRepo.updateStatus(expenseId, 'pending');

    // Create approval request
    const workflowService = new ApprovalWorkflowService(this.orgId);
    const approvalRequest = await workflowService.createExpenseApprovalRequest(expenseId, submittedBy);

    logInfo('Expense submitted for approval', { expenseId, approvalRequestId: approvalRequest._id });

    return await expenseRepo.findById(expenseId);
  }

  /**
   * Get expenses with filters
   */
  async getExpenses(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    return await expenseRepo.findByOrgId(this.orgId, filters);
  }

  /**
   * Get expense by ID
   */
  async getExpenseById(expenseId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    return expense;
  }

  /**
   * Update expense
   */
  async updateExpense(expenseId, updateData, userId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    // Only allow updates if expense is draft or if user is the submitter
    if (expense.status !== 'draft' && expense.submitted_by.toString() !== userId.toString()) {
      throw new AppError('You can only update draft expenses or your own expenses', 403, 'UNAUTHORIZED');
    }

    // Don't allow status changes through update
    delete updateData.status;
    delete updateData.approval_request_id;
    delete updateData.approval_matrix_id;

    return await expenseRepo.update(expenseId, updateData);
  }

  /**
   * Delete expense
   */
  async deleteExpense(expenseId, userId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    // Only allow deletion if expense is draft or if user is the submitter
    if (expense.status !== 'draft' && expense.submitted_by.toString() !== userId.toString()) {
      throw new AppError('You can only delete draft expenses or your own expenses', 403, 'UNAUTHORIZED');
    }

    await expenseRepo.delete(expenseId);
    logInfo('Expense deleted', { expenseId, userId });
  }

  /**
   * Cancel expense
   */
  async cancelExpense(expenseId, userId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    if (expense.submitted_by.toString() !== userId.toString()) {
      throw new AppError('You can only cancel your own expenses', 403, 'UNAUTHORIZED');
    }

    if (expense.status === 'approved' || expense.status === 'paid') {
      throw new AppError('Cannot cancel approved or paid expenses', 400, 'INVALID_STATUS');
    }

    // Cancel approval request if exists
    if (expense.approval_request_id) {
      await approvalRequestRepo.updateStatus(expense.approval_request_id, 'cancelled', {
        cancelled_by: userId,
        cancelled_at: new Date()
      });
    }

    // Update expense status
    await expenseRepo.updateStatus(expenseId, 'cancelled');

    logInfo('Expense cancelled', { expenseId, userId });
    return await expenseRepo.findById(expenseId);
  }

  async assignExpense(expenseId, assignedToUserId, assigningUserId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    // Only approved expenses can be assigned for payment
    if (expense.status !== 'approved') {
      throw new AppError('Only approved expenses can be assigned for payment', 400, 'INVALID_STATUS');
    }

    // Verify that the user to assign exists
    const assignedUser = await userRepo.findById(assignedToUserId);
    if (!assignedUser) {
      throw new AppError('User to assign not found', 404, 'USER_NOT_FOUND');
    }

    // Update expense with assigned user
    const updatedExpense = await expenseRepo.update(expenseId, {
      assigned_to: assignedToUserId
    });

    logInfo('Expense assigned for payment', { expenseId, assignedTo: assignedToUserId, assignedBy: assigningUserId });
    return updatedExpense;
  }

  async submitPaymentProof(expenseId, paymentData, userId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    // Only approved expenses can have payment proof submitted
    if (expense.status !== 'approved') {
      throw new AppError('Only approved expenses can have payment proof submitted', 400, 'INVALID_STATUS');
    }

    // Check if user is assigned to this expense
    const assignedId = expense.assigned_to?._id || expense.assigned_to;
    if (assignedId && assignedId.toString() !== userId.toString()) {
      throw new AppError('You are not assigned to process this payment', 403, 'UNAUTHORIZED');
    }

    // Validate required payment data
    if (!paymentData.payment_method) {
      throw new AppError('Payment method is required', 400, 'VALIDATION_ERROR');
    }

    if (!paymentData.payment_proof) {
      throw new AppError('Payment proof is required', 400, 'VALIDATION_ERROR');
    }

    // Update expense with payment proof and mark as paid
    const updateData = {
      payment_method: paymentData.payment_method,
      payment_proof: paymentData.payment_proof,
      payment_proof_name: paymentData.payment_proof_name,
      payment_date: paymentData.payment_date || new Date(),
      payment_notes: paymentData.payment_notes,
      payment_reference: paymentData.payment_reference,
      status: 'paid',
      paid_at: new Date()
    };

    const updatedExpense = await expenseRepo.update(expenseId, updateData);

    logInfo('Payment proof submitted, expense marked as paid', { 
      expenseId, 
      paymentMethod: paymentData.payment_method,
      userId 
    });

    return updatedExpense;
  }
}
