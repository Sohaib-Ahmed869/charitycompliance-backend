/**
 * Approval Workflow Service
 * 
 * Core business logic for approval workflows
 * Handles approver resolution, approval request creation, and approval processing
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';

export class ApprovalWorkflowService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /**
   * Resolve approvers from approval rule
   * Converts position/department/user references to actual user IDs
   */
  async resolveApprovers(approvalRule, orgId) {
    const tenantDb = await this.getTenantDb();
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const approvers = [];

    for (const approverConfig of approvalRule.requires_approval_from) {
      let userIds = [];

      if (approverConfig.user_id) {
        // Specific user
        userIds = [approverConfig.user_id];
      } else if (approverConfig.position_id) {
        // Find all users in this position
        userIds = await userPositionRepo.findUsersByPositionId(approverConfig.position_id);
        if (userIds.length === 0) {
          logError('No users found for position', { positionId: approverConfig.position_id });
          throw new AppError(
            `No active users found for position. Please assign users to this position.`,
            400,
            'NO_APPROVERS_FOUND'
          );
        }
      } else if (approverConfig.department_id) {
        // Find all users in this department
        userIds = await userPositionRepo.findUsersByDepartmentId(approverConfig.department_id);
        if (userIds.length === 0) {
          logError('No users found for department', { departmentId: approverConfig.department_id });
          throw new AppError(
            `No active users found for department. Please assign users to this department.`,
            400,
            'NO_APPROVERS_FOUND'
          );
        }
      }

      // Create approver entries for each user
      userIds.forEach(userId => {
        approvers.push({
          user_id: userId,
          position_id: approverConfig.position_id || null,
          department_id: approverConfig.department_id || null,
          level: approverConfig.approval_level
        });
      });
    }

    // Sort by approval level
    return approvers.sort((a, b) => a.level - b.level);
  }

  /**
   * Find matching approval rule from matrix
   */
  async findMatchingRule(actionType, amount, orgId) {
    const tenantDb = await this.getTenantDb();
    const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);

    // Get default or active approval matrix
    let matrix = await approvalMatrixRepo.findDefault(orgId);
    if (!matrix) {
      const matrices = await approvalMatrixRepo.findByOrgId(orgId, { is_active: true });
      if (matrices.length === 0) {
        throw new AppError(
          'No approval matrix configured. Please set up an approval matrix first.',
          400,
          'NO_APPROVAL_MATRIX'
        );
      }
      matrix = matrices[0];
    }

    // Find matching rule
    const matchingRule = matrix.rules.find(rule => {
      if (rule.action_type !== actionType || !rule.is_active) {
        return false;
      }

      const minMatch = rule.min_amount === undefined || amount >= rule.min_amount;
      const maxMatch = rule.max_amount === undefined || amount <= rule.max_amount;

      return minMatch && maxMatch;
    });

    if (!matchingRule) {
      throw new AppError(
        `No approval rule found for ${actionType} with amount ${amount}. Please configure an approval rule.`,
        400,
        'NO_MATCHING_RULE'
      );
    }

    return { matrix, rule: matchingRule };
  }

  /**
   * Create approval request for an expense
   */
  async createExpenseApprovalRequest(expenseId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get expense
    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    // Find matching approval rule
    const { matrix, rule } = await this.findMatchingRule('expense', expense.amount, this.orgId);

    // Resolve approvers
    const approvers = await this.resolveApprovers(rule, this.orgId);

    // Create approval steps
    const approvalSteps = approvers.map(approver => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    // Create approval request
    const approvalRequest = await approvalRequestRepo.create({
      org_id: this.orgId,
      request_type: 'expense',
      entity_id: expenseId,
      entity_type: 'expense',
      amount: expense.amount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Update expense with approval request reference
    await expenseRepo.update(expenseId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending'
    });

    logInfo('Approval request created', {
      expenseId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    // TODO: Send notifications to approvers

    return approvalRequest;
  }

  /**
   * Process approval (approve or reject)
   */
  async processApproval(approvalRequestId, stepIndex, userId, decision, comments = null, ipAddress = null, userAgent = null) {
    const tenantDb = await this.getTenantDb();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const expenseRepo = new ExpenseRepository(tenantDb);

    // Get approval request
    const request = await approvalRequestRepo.findById(approvalRequestId);
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    // Check if request is still pending
    if (request.status !== 'pending') {
      throw new AppError(
        `Approval request is already ${request.status}`,
        400,
        'REQUEST_NOT_PENDING'
      );
    }

    // Get the approval step
    const step = request.approval_steps[stepIndex];
    if (!step) {
      throw new AppError('Approval step not found', 404, 'STEP_NOT_FOUND');
    }

    // Verify user is the approver for this step
    if (step.approver_user_id.toString() !== userId.toString()) {
      throw new AppError('You are not authorized to approve this step', 403, 'UNAUTHORIZED');
    }

    // Check if step is already processed
    if (step.status !== 'pending') {
      throw new AppError(`This step is already ${step.status}`, 400, 'STEP_ALREADY_PROCESSED');
    }

    // For sequential approval, check if previous steps are approved
    if (request.approval_type === 'sequential') {
      for (let i = 0; i < stepIndex; i++) {
        if (request.approval_steps[i].status !== 'approved') {
          throw new AppError(
            'Previous approval steps must be completed first',
            400,
            'PREVIOUS_STEPS_PENDING'
          );
        }
      }
    }

    // Update step
    const updateData = {
      status: decision,
      comments: comments || null
    };

    if (decision === 'approved') {
      updateData.approved_at = new Date();
    } else if (decision === 'rejected') {
      updateData.rejected_at = new Date();
      updateData.rejection_reason = comments;
    }

    if (ipAddress) updateData.ip_address = ipAddress;
    if (userAgent) updateData.user_agent = userAgent;

    await approvalRequestRepo.updateApprovalStep(approvalRequestId, stepIndex, updateData);

    // Check if all approvals are complete
    const updatedRequest = await approvalRequestRepo.findById(approvalRequestId);
    const allSteps = updatedRequest.approval_steps;

    if (decision === 'rejected') {
      // Reject entire request
      await approvalRequestRepo.updateStatus(approvalRequestId, 'rejected');
      
      // Update expense
      await expenseRepo.updateStatus(request.entity_id, 'rejected', {
        rejection_reason: comments,
        rejected_by: userId,
        rejected_at: new Date()
      });

      // TODO: Send notifications
      return updatedRequest;
    }

    // Check if all required approvals are received
    let allApproved = false;
    
    if (request.approval_type === 'any') {
      // Any one approval is enough
      allApproved = allSteps.some(s => s.status === 'approved');
    } else if (request.approval_type === 'parallel') {
      // All steps must be approved
      allApproved = allSteps.every(s => s.status === 'approved' || s.status === 'rejected');
      // But if any is rejected, the whole thing is rejected
      if (allSteps.some(s => s.status === 'rejected')) {
        await approvalRequestRepo.updateStatus(approvalRequestId, 'rejected');
        await expenseRepo.updateStatus(request.entity_id, 'rejected', {
          rejection_reason: 'Rejected by one or more approvers',
          rejected_by: userId
        });
        return updatedRequest;
      }
    } else if (request.approval_type === 'sequential') {
      // All steps must be approved in order
      allApproved = allSteps.every(s => s.status === 'approved');
    }

    if (allApproved) {
      // All approvals complete
      await approvalRequestRepo.updateStatus(approvalRequestId, 'approved');
      
      // Update expense
      await expenseRepo.updateStatus(request.entity_id, 'approved', {
        approved_at: new Date()
      });

      // TODO: Send notifications
      logInfo('All approvals completed', { approvalRequestId, entityId: request.entity_id });
    }

    return await approvalRequestRepo.findById(approvalRequestId);
  }

  /**
   * Get pending approvals for a user
   */
  async getPendingApprovalsForUser(userId) {
    const tenantDb = await this.getTenantDb();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const requests = await approvalRequestRepo.findPendingByApprover(userId);
    
    // Filter to only show steps that are pending for this user
    return requests.map(request => {
      const userSteps = request.approval_steps.filter(
        step => step.approver_user_id.toString() === userId.toString() && step.status === 'pending'
      );
      
      // For sequential, only show the first pending step
      if (request.approval_type === 'sequential') {
        const firstPendingIndex = request.approval_steps.findIndex(s => s.status === 'pending');
        if (firstPendingIndex >= 0 && request.approval_steps[firstPendingIndex].approver_user_id.toString() === userId.toString()) {
          return {
            ...request.toObject(),
            current_step: firstPendingIndex,
            can_approve: true
          };
        }
        return null;
      }
      
      return {
        ...request.toObject(),
        user_steps: userSteps,
        can_approve: userSteps.length > 0
      };
    }).filter(r => r !== null);
  }
}
