/**
 * Expense Service
 * 
 * Business logic for expense/invoice management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
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
    const notificationRepo = new NotificationRepository(tenantDb);

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
      assigned_to: assignedToUserId,
      // keep new workflow fields aligned for backwards compat
      payment_processor_id: assignedToUserId,
      payment_stage: 'processing'
    });

    logInfo('Expense assigned for payment', { expenseId, assignedTo: assignedToUserId, assignedBy: assigningUserId });

    // Notify assigned user to process payment
    try {
      await notificationRepo.create({
        user_id: assignedToUserId,
        type: 'expense_payment_processing_assigned',
        title: 'Payment assigned to you',
        message: 'You have been assigned to process an approved expense payment. Please add payment details and submit for review.',
        link: `/expenses/${expenseId}#payment-section`,
        related_entity_id: expenseId,
        related_entity_type: 'expense',
        created_at: new Date()
      });
    } catch (err) {
      logError('Failed to create expense payment assigned notification', { error: err?.message, expenseId, assignedTo: assignedToUserId });
    }

    return updatedExpense;
  }

  async assignPaymentTeam(expenseId, processorUserId, reviewerUserId, assigningUserId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');

    if (expense.status !== 'approved') {
      throw new AppError('Only approved expenses can be assigned for payment', 400, 'INVALID_STATUS');
    }

    const processor = await userRepo.findById(processorUserId);
    if (!processor) throw new AppError('Payment processor not found', 404, 'USER_NOT_FOUND');

    const reviewer = await userRepo.findById(reviewerUserId);
    if (!reviewer) throw new AppError('Payment reviewer not found', 404, 'USER_NOT_FOUND');

    const updatedExpense = await expenseRepo.update(expenseId, {
      payment_processor_id: processorUserId,
      payment_reviewer_id: reviewerUserId,
      payment_stage: 'processing',
      // legacy: keep assigned_to as processor for existing UI/exports
      assigned_to: processorUserId
    });

    logInfo('Expense payment team assigned', { expenseId, processorUserId, reviewerUserId, assignedBy: assigningUserId });

    // notify processor
    try {
      await notificationRepo.create({
        user_id: processorUserId,
        type: 'expense_payment_processing_assigned',
        title: 'Payment processing assigned to you',
        message: 'You have been assigned to add payment details for an approved expense. Submit the payment(s) for review when ready.',
        link: `/expenses/${expenseId}#payment-section`,
        related_entity_id: expenseId,
        related_entity_type: 'expense',
        created_at: new Date()
      });
    } catch (err) {
      logError('Failed to create expense payment processing assignment notification', { error: err?.message, expenseId, processorUserId });
    }

    // notify reviewer (heads-up)
    try {
      await notificationRepo.create({
        user_id: reviewerUserId,
        type: 'expense_payment_review_required',
        title: 'Payment review will be required',
        message: 'You have been assigned as the payment reviewer for an approved expense. You’ll be notified once payment details are submitted.',
        link: `/expenses/${expenseId}#payment-section`,
        related_entity_id: expenseId,
        related_entity_type: 'expense',
        created_at: new Date()
      });
    } catch (err) {
      logError('Failed to create expense payment reviewer heads-up notification', { error: err?.message, expenseId, reviewerUserId });
    }

    return updatedExpense;
  }

  async submitPaymentsForReview(expenseId, { payments = [] } = {}, userId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');

    if (expense.status !== 'approved') {
      throw new AppError('Only approved expenses can have payment details submitted', 400, 'INVALID_STATUS');
    }

    const processorId = expense.payment_processor_id?._id || expense.payment_processor_id || expense.assigned_to?._id || expense.assigned_to;
    if (processorId && processorId.toString() !== userId.toString()) {
      throw new AppError('You are not assigned to process this payment', 403, 'UNAUTHORIZED');
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      throw new AppError('At least one payment entry is required', 400, 'VALIDATION_ERROR');
    }

    const normalized = payments.map(p => ({
      amount: p.amount,
      payment_method: p.payment_method,
      payment_proof: p.payment_proof,
      payment_proof_name: p.payment_proof_name,
      payment_date: p.payment_date || new Date(),
      payment_reference: p.payment_reference,
      payment_notes: p.payment_notes,
      created_by: userId,
      created_at: new Date()
    }));

    // Basic validation per entry
    for (const p of normalized) {
      if (!p.payment_method) throw new AppError('Payment method is required', 400, 'VALIDATION_ERROR');
      if (!p.payment_proof) throw new AppError('Payment proof is required', 400, 'VALIDATION_ERROR');
    }

    const updatedExpense = await expenseRepo.update(expenseId, {
      payments: normalized,
      payment_stage: 'review',
      payment_review: { status: null, review_notes: null, reviewed_by: null, reviewed_at: null }
    });

    const reviewerId = expense.payment_reviewer_id?._id || expense.payment_reviewer_id;
    if (reviewerId) {
      try {
        await notificationRepo.create({
          user_id: reviewerId,
          type: 'expense_payment_review_required',
          title: 'Payment review required',
          message: 'Payment details have been submitted for an approved expense. Please review and accept.',
          link: `/expenses/${expenseId}#payment-section`,
          related_entity_id: expenseId,
          related_entity_type: 'expense',
          created_at: new Date()
        });
      } catch (err) {
        logError('Failed to create expense payment review notification', { error: err?.message, expenseId, reviewerId });
      }
    }

    return updatedExpense;
  }

  async reviewPayments(expenseId, { action = 'accept', review_notes = '', signature_data = null } = {}, userId) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const expense = await expenseRepo.findById(expenseId);
    if (!expense) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');

    if (expense.status !== 'approved') {
      throw new AppError('Only approved expenses can be reviewed for payment completion', 400, 'INVALID_STATUS');
    }

    if ((expense.payment_stage || 'unassigned') !== 'review') {
      throw new AppError('Payment is not pending review', 400, 'INVALID_STATUS');
    }

    const reviewerId = expense.payment_reviewer_id?._id || expense.payment_reviewer_id;
    if (reviewerId && reviewerId.toString() !== userId.toString()) {
      throw new AppError('You are not assigned as the payment reviewer for this expense', 403, 'UNAUTHORIZED');
    }

    const isAccept = action === 'accept';
    if (isAccept && !signature_data) {
      throw new AppError('Reviewer signature is required to complete payment', 400, 'VALIDATION_ERROR');
    }
    const update = {
      payment_review: {
        status: isAccept ? 'accepted' : 'changes_requested',
        review_notes: review_notes || null,
        signature_data: isAccept ? signature_data : null,
        reviewed_by: userId,
        reviewed_at: new Date()
      },
      payment_stage: isAccept ? 'completed' : 'processing'
    };

    if (isAccept) {
      update.status = 'paid';
      update.paid_at = new Date();
      // Legacy: keep first payment mirrored for existing “Payment Completed” block if needed
      const first = (expense.payments || [])[0];
      if (first) {
        update.payment_method = first.payment_method;
        update.payment_proof = first.payment_proof;
        update.payment_proof_name = first.payment_proof_name;
        update.payment_date = first.payment_date;
        update.payment_reference = first.payment_reference;
        update.payment_notes = first.payment_notes;
      }
    }

    const updatedExpense = await expenseRepo.update(expenseId, update);

    // notify processor + submitter when completed
    if (isAccept) {
      const processorId = expense.payment_processor_id?._id || expense.payment_processor_id || expense.assigned_to?._id || expense.assigned_to;
      const submitterId = expense.submitted_by?._id || expense.submitted_by;
      const targets = [processorId, submitterId].filter(Boolean).map(String);
      const uniq = [...new Set(targets)];
      for (const uid of uniq) {
        try {
          await notificationRepo.create({
            user_id: uid,
            type: 'expense_payment_completed',
            title: 'Expense payment completed',
            message: 'Payment details were accepted by the reviewer and the expense is now marked as paid.',
            link: `/expenses/${expenseId}#payment-section`,
            related_entity_id: expenseId,
            related_entity_type: 'expense',
            created_at: new Date()
          });
        } catch (err) {
          logError('Failed to create expense payment completed notification', { error: err?.message, expenseId, uid });
        }
      }
    }

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
