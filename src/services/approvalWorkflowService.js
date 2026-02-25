/**
 * Approval Workflow Service
 * 
 * Core business logic for approval workflows
 * Handles approver resolution, approval request creation, and approval processing
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { PolicyRepository } from '../repositories/policyRepository.js';
import { ProjectRegisterRepository } from '../repositories/projectRegisterRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ProjectRegisterService } from './projectRegisterService.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';

export class ApprovalWorkflowService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /** Ensure User model (and other shared refs) are registered on this tenant connection. */
  _ensureTenantModels(tenantDb) {
    // Registers User schema for this connection if not already present
    void new UserRepository(tenantDb);
  }

  /** Resolve tenant slug to Organization ObjectId (org_id fields require ObjectId). */
  async _getOrgObjectId() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    return org._id;
  }

  /** Normalize legacy action types to current UI tags. */
  _normalizeActionType(actionType) {
    const t = String(actionType || '').toLowerCase().trim();
    if (t === 'risk_management') return 'risk';
    if (t === 'grant_approval') return 'grant';
    if (t === 'policy_approval') return 'policy';
    return t;
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
    this._ensureTenantModels(tenantDb);
    const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
    const normalizedActionType = this._normalizeActionType(actionType);

    // Load all active matrices and search across ALL of them, since each
    // workflow type (expense, grant, risk, etc.) may be stored in its own matrix.
    const matrices = await approvalMatrixRepo.findByOrgId(orgId);
    if (!matrices || matrices.length === 0) {
      throw new AppError(
        'No approval matrix configured. Please set up an approval matrix first.',
        400,
        'NO_APPROVAL_MATRIX'
      );
    }

    let selectedMatrix = null;
    let selectedRule = null;

    for (const matrix of matrices) {
      for (const rule of matrix.rules) {
        if (!rule.is_active) continue;
        if (this._normalizeActionType(rule.action_type) !== normalizedActionType) continue;

        const minMatch = rule.min_amount === undefined || amount >= rule.min_amount;
        const maxMatch = rule.max_amount === undefined || amount <= rule.max_amount;

        if (minMatch && maxMatch) {
          selectedMatrix = matrix;
          selectedRule = rule;
          break;
        }
      }
      if (selectedRule) break;
    }

    if (!selectedRule) {
      throw new AppError(
        `No approval rule found for ${normalizedActionType} with amount ${amount}. Please configure an approval rule.`,
        400,
        'NO_MATCHING_RULE'
      );
    }

    return { matrix: selectedMatrix, rule: selectedRule };
  }

  /**
   * Create approval request for an expense
   */
  async createExpenseApprovalRequest(expenseId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const expenseRepo = new ExpenseRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get expense
    const expense = await expenseRepo.findById(expenseId);
    if (!expense) {
      throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    }

    // Find matching approval rule
    const { matrix, rule } = await this.findMatchingRule('expense', expense.amount, orgObjectId);
    
    // Resolve approvers
    const approvers = await this.resolveApprovers(rule, orgObjectId);

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
      org_id: orgObjectId,
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
   * Create approval request for a risk (action_type: risk_management)
   * Uses amount 0 to match risk_management rules (min_amount 0, no max).
   * If risk has department_id, department head is inserted as step 0 (first approver).
   */
  async createRiskApprovalRequest(riskId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const riskRepo = new RiskRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const boardMemberRepo = new BoardMemberRepository(tenantDb);

    const risk = await riskRepo.findById(riskId);
    if (!risk) {
      throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
    }

    // Make sure we always have a valid submitting user id
    const submittingUserId =
      submittedBy ||
      (risk.submitted_by && typeof risk.submitted_by === 'object'
        ? risk.submitted_by._id
        : risk.submitted_by);

    // Risk workflow tag in UI is "risk"
    const { matrix, rule } = await this.findMatchingRule('risk', 0, orgObjectId);

    // Build approvers directly from the matrix rule so we always reflect
    // the configured positions/departments, even when no users exist yet.
    const approvers = [];
    for (const approverConfig of rule.requires_approval_from) {
      let userIds = [];

      if (approverConfig.user_id) {
        userIds = [approverConfig.user_id];
      } else if (approverConfig.position_id) {
        // Try to resolve users for this position; may be empty
        userIds = await userPositionRepo.findUsersByPositionId(approverConfig.position_id);
      }

      if (userIds.length > 0) {
        userIds.forEach((userId) => {
          approvers.push({
            user_id: userId,
            position_id: approverConfig.position_id || null,
            department_id: approverConfig.department_id || null,
            level: approverConfig.approval_level
          });
        });
      } else {
        // No users yet – keep the position/department so UI can show who SHOULD approve.
        approvers.push({
          user_id: null,
          position_id: approverConfig.position_id || null,
          department_id: approverConfig.department_id || null,
          level: approverConfig.approval_level
        });
      }
    }

    // Sort by approval level
    approvers.sort((a, b) => a.level - b.level);

    // Prepend department head as step 0 if risk has department_id
    const departmentId = risk.department_id?._id || risk.department_id;
    const departmentHeadSteps = [];
    if (departmentId) {
      const deptHead = await boardMemberRepo.findDepartmentHeadByDepartmentId(orgObjectId, departmentId);
      if (deptHead) {
        const headUserId = deptHead.user_id?._id || deptHead.user_id;
        departmentHeadSteps.push({
          level: 1,
          approver_user_id: headUserId || undefined,
          approver_position_id: deptHead.position_id?._id || deptHead.position_id,
          approver_department_id: departmentId,
          is_department_head: true,
          status: 'pending'
        });
      }
    }

    // Shift matrix rule levels: existing steps become 2, 3, 4... (add 1 to each level) since dept head is 1
    const matrixSteps = approvers.map((approver) => ({
      level: approver.level + 1,
      approver_user_id: approver.user_id || undefined,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalSteps = [...departmentHeadSteps, ...matrixSteps];

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'risk',
      entity_id: riskId,
      entity_type: 'risk',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittingUserId
    });

    await riskRepo.update(riskId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending',
      submitted_by: submittingUserId
    });

    logInfo('Risk approval request created', {
      riskId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Create approval request for a policy (action_type: policy)
   * Policies follow the normal approval matrix workflow only (no department head pre-approval).
   */
  async createPolicyApprovalRequest(policyId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const policyRepo = new PolicyRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);

    const policy = await policyRepo.findById(policyId);
    if (!policy) {
      throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');
    }

    const { matrix, rule } = await this.findMatchingRule('policy', 0, orgObjectId);

    const approvers = [];
    for (const approverConfig of rule.requires_approval_from) {
      let userIds = [];
      if (approverConfig.user_id) {
        userIds = [approverConfig.user_id];
      } else if (approverConfig.position_id) {
        userIds = await userPositionRepo.findUsersByPositionId(approverConfig.position_id);
      }

      if (userIds.length > 0) {
        userIds.forEach((userId) => {
          approvers.push({
            user_id: userId,
            position_id: approverConfig.position_id || null,
            department_id: approverConfig.department_id || null,
            level: approverConfig.approval_level
          });
        });
      } else {
        approvers.push({
          user_id: null,
          position_id: approverConfig.position_id || null,
          department_id: approverConfig.department_id || null,
          level: approverConfig.approval_level
        });
      }
    }

    approvers.sort((a, b) => a.level - b.level);

    // Policy: normal workflow only (no department head pre-approval)
    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id || undefined,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'policy',
      entity_id: policyId,
      entity_type: 'policy',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    await policyRepo.update(policyId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'under_review'
    });

    logInfo('Policy approval request created', {
      policyId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Create approval request for a risk treatment
   * Triggers workflow when a treatment is added to a risk
   * Risk treatment workflows have only one approval rule per organization
   */
  async createRiskTreatmentApprovalRequest(riskId, treatmentIndex, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const riskRepo = new RiskRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const boardMemberRepo = new BoardMemberRepository(tenantDb);

    const risk = await riskRepo.findById(riskId);
    if (!risk) {
      throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
    }

    const { matrix, rule } = await this.findMatchingRule('risk_treatment', 0, orgObjectId);

    const approvers = [];
    for (const approverConfig of rule.requires_approval_from) {
      let userIds = [];
      if (approverConfig.user_id) {
        userIds = [approverConfig.user_id];
      } else if (approverConfig.position_id) {
        userIds = await userPositionRepo.findUsersByPositionId(approverConfig.position_id);
      }

      if (userIds.length > 0) {
        userIds.forEach((userId) => {
          approvers.push({
            user_id: userId,
            position_id: approverConfig.position_id || null,
            department_id: approverConfig.department_id || null,
            level: approverConfig.approval_level
          });
        });
      } else {
        approvers.push({
          user_id: null,
          position_id: approverConfig.position_id || null,
          department_id: approverConfig.department_id || null,
          level: approverConfig.approval_level
        });
      }
    }

    approvers.sort((a, b) => a.level - b.level);

    // Risk treatment does NOT require department head approval
    // Only the workflow approvers from the matrix are involved
    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id || undefined,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'risk_treatment',
      entity_id: riskId,
      entity_type: 'risk',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy,
      treatment_index: treatmentIndex // Track which treatment is being approved
    });

    // Risk stays in 'under_treatment' - it's not resolved until treatment is approved
    await riskRepo.update(riskId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id
    });

    logInfo('Risk treatment approval request created', {
      riskId,
      treatmentIndex,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Process approval (approve or reject)
   */
  async processApproval(approvalRequestId, stepIndex, userId, decision, comments = null, ipAddress = null, userAgent = null, acknowledgement = null) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const expenseRepo = new ExpenseRepository(tenantDb);
    const riskRepo = new RiskRepository(tenantDb);

    // Get approval request
    const request = await approvalRequestRepo.findById(approvalRequestId);
    logInfo('Processing approval step', {
      approvalRequestId,
      entityType: request?.entity_type,
      requestType: request?.request_type,
      approvalType: request?.approval_type,
      currentStatus: request?.status,
      stepIndex,
      decision
    });
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    // Check if request is still pending
    if (request.status === 'paused_for_coi') {
      throw new AppError(
        'Approval request is paused due to a conflict of interest review',
        400,
        'REQUEST_PAUSED_FOR_COI'
      );
    }

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

    // Check if step is already processed
    if (step.status !== 'pending') {
      throw new AppError(`This step is already ${step.status}`, 400, 'STEP_ALREADY_PROCESSED');
    }

    // Verify user is authorized to approve this step (by user_id or position)
    const userPositionIds = await this._getUserPositionIds(userId);
    const canApprove = this._canUserApproveStep(step, userId, userPositionIds);
    if (!canApprove) {
      throw new AppError('You are not authorized to approve this step', 403, 'UNAUTHORIZED');
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

    // Add acknowledgement data if provided
    if (acknowledgement) {
      if (acknowledgement.note) {
        updateData.acknowledgement_note = acknowledgement.note;
      }
      if (acknowledgement.files && Array.isArray(acknowledgement.files) && acknowledgement.files.length > 0) {
        updateData.acknowledgement_files = acknowledgement.files;
      }
    }

    // If approving by position (approver_user_id was null), record who actually approved
    if (!step.approver_user_id) {
      updateData.approver_user_id = userId;
    }

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
    logInfo('Approval step updated', {
      approvalRequestId,
      entityType: updatedRequest?.entity_type,
      approvalType: updatedRequest?.approval_type,
      decision,
      stepIndex,
      steps: (allSteps || []).map((s) => ({ level: s.level, status: s.status }))
    });

    if (decision === 'rejected') {
      await approvalRequestRepo.updateStatus(approvalRequestId, 'rejected');

      if (request.entity_type === 'expense') {
        await expenseRepo.updateStatus(request.entity_id, 'rejected', {
          rejection_reason: comments,
          rejected_by: userId,
          rejected_at: new Date()
        });
      } else if (request.entity_type === 'risk') {
        // For risk_treatment requests, keep as 'under_treatment' on rejection
        if (request.request_type === 'risk_treatment') {
          // Treatment was rejected - keep risk under treatment
          await riskRepo.update(request.entity_id, { approval_request_id: null });
        } else {
          // For regular risk approvals, mark as rejected
          await riskRepo.updateStatus(request.entity_id, 'rejected');
        }
      } else if (request.entity_type === 'policy') {
        const policyRepo = new PolicyRepository(tenantDb);
        await policyRepo.update(request.entity_id, { status: 'draft' });
      }

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
        if (request.entity_type === 'expense') {
          await expenseRepo.updateStatus(request.entity_id, 'rejected', {
            rejection_reason: 'Rejected by one or more approvers',
            rejected_by: userId
          });
        } else if (request.entity_type === 'risk') {
          await riskRepo.updateStatus(request.entity_id, 'rejected');
        } else if (request.entity_type === 'policy') {
          const policyRepo = new PolicyRepository(tenantDb);
          await policyRepo.update(request.entity_id, { status: 'draft' });
        }
        return updatedRequest;
      }
    } else if (request.approval_type === 'sequential') {
      allApproved = allSteps.every(s => s.status === 'approved');
    }

    if (allApproved) {
      logInfo('All approval steps approved, updating entity status', {
        approvalRequestId,
        entityId: request.entity_id,
        entityType: request.entity_type
      });

      await approvalRequestRepo.updateStatus(approvalRequestId, 'approved');

      if (request.entity_type === 'expense') {
        await expenseRepo.updateStatus(request.entity_id, 'approved', { approved_at: new Date() });
        logInfo('Expense status updated from approval', { approvalRequestId, entityId: request.entity_id });
      } else if (request.entity_type === 'risk') {
        if (request.request_type === 'risk_treatment') {
          // Treatment approved - mark risk as resolved
          await riskRepo.updateStatus(request.entity_id, 'resolved');
          logInfo('Risk status updated to resolved from treatment approval', { approvalRequestId, entityId: request.entity_id });
        } else {
          // Regular risk approval - mark as under_treatment
          await riskRepo.updateStatus(request.entity_id, 'under_treatment');
          logInfo('Risk status updated from approval', { approvalRequestId, entityId: request.entity_id });
        }
      } else if (request.entity_type === 'policy') {
        const policyRepo = new PolicyRepository(tenantDb);
        const updatedPolicy = await policyRepo.update(request.entity_id, { status: 'active' });
        logInfo('Policy status updated from approval', {
          approvalRequestId,
          entityId: request.entity_id,
          previousStatus: request.status,
          newStatus: updatedPolicy?.status
        });
      } else if (request.entity_type === 'funding_agreement') {
        const FundingAgreement = tenantDb.model('FundingAgreement');
        const fundingAgreement = await FundingAgreement.findByIdAndUpdate(
          request.entity_id, 
          { status: 'approved' },
          { new: true }
        );
        logInfo('Funding agreement status updated from approval', { 
          approvalRequestId, 
          entityId: request.entity_id,
          agreementTitle: fundingAgreement?.agreement_title
        });

        // Auto-create a project for this approved funding agreement
        try {
          const projectService = new ProjectRegisterService(this.orgId);
          const projectData = {
            agreement_id: fundingAgreement._id,
            agreement_title: fundingAgreement.agreement_title,
            project_name: fundingAgreement.agreement_title, // Use agreement title as project name
            description: fundingAgreement.description || `Project for ${fundingAgreement.agreement_title}`,
            planned_start_date: fundingAgreement.start_date,
            planned_end_date: fundingAgreement.end_date,
            status: 'active', // Auto-approve since created from approved agreement
            created_by: userId
          };
          
          const newProject = await projectService.createProject(projectData);
          logInfo('Auto-created project from approved funding agreement', {
            fundingAgreementId: fundingAgreement._id,
            projectId: newProject._id,
            projectName: newProject.project_name
          });
        } catch (err) {
          logError('Failed to auto-create project for approved funding agreement', {
            fundingAgreementId: fundingAgreement._id,
            error: err.message
          });
          // Don't fail the approval process if project creation fails
        }
      } else if (request.entity_type === 'project') {
        try {
          const projectRepo = new ProjectRegisterRepository(tenantDb);
          const updatedProject = await projectRepo.update(request.entity_id, { status: 'active' });
          logInfo('Project status updated to active from approval', {
            approvalRequestId,
            entityId: request.entity_id,
            projectName: updatedProject?.project_name,
            success: !!updatedProject
          });
          if (!updatedProject) {
            logError('Project update returned null/undefined', {
              approvalRequestId,
              entityId: request.entity_id
            });
          }
        } catch (projectUpdateErr) {
          logError('Error updating project status after approval', {
            approvalRequestId,
            entityId: request.entity_id,
            error: projectUpdateErr.message,
            stack: projectUpdateErr.stack
          });
          // Don't fail the approval process if project update fails
        }
      } else if (request.entity_type === 'partner') {
        const Partner = tenantDb.model('PartnerVetting');
        await Partner.findByIdAndUpdate(request.entity_id, { status: 'approved' });
        logInfo('Partner status updated from approval', { approvalRequestId, entityId: request.entity_id });
      }

      logInfo('All approvals completed', { approvalRequestId, entityId: request.entity_id, entityType: request.entity_type });

      // Notify all parties (submitter + approvers) that the workflow is approved
      const typeLabels = {
        expense: 'Expense Reimbursement',
        risk: 'Risk Assessment',
        risk_treatment: 'Risk Treatment',
        coi: 'Conflict of Interest',
        purchase: 'Purchase',
        grant: 'Grant',
        funding_agreement: 'Funding Agreement',
        partner_vetting: 'Partner Vetting',
        project: 'Project',
        policy: 'Policy',
        policy_approval: 'Policy Approval',
        document_approval: 'Document Approval',
        hr: 'HR',
        other: 'Approval Request'
      };
      const workflowTitle = typeLabels[request.request_type] || request.request_type || 'Approval Request';
      const userIds = new Set();

      const submittedById = request.submitted_by?._id || request.submitted_by;
      if (submittedById) userIds.add(String(submittedById));

      const finalRequest = await approvalRequestRepo.findById(approvalRequestId);
      (finalRequest?.approval_steps || allSteps || []).forEach((step) => {
        const approverId = step.approver_user_id?._id || step.approver_user_id;
        if (approverId) userIds.add(String(approverId));
      });

      const notificationRepo = new NotificationRepository(tenantDb);
      const notifications = [...userIds].map((uid) => ({
        user_id: uid,
        type: 'workflow_approved',
        title: 'Workflow Approved',
        message: `${workflowTitle} has been fully approved by all approvers.`,
        link: `/approvals/${approvalRequestId}`,
        related_entity_id: approvalRequestId,
        related_entity_type: 'approval_request'
      }));

      if (notifications.length > 0) {
        await notificationRepo.createMany(notifications);
      }
    }

    return await approvalRequestRepo.findById(approvalRequestId);
  }

  /**
   * Get the position IDs that a user holds (from board_members and UserPosition)
   */
  async _getUserPositionIds(userId) {
    const tenantDb = await this.getTenantDb();
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const boardMemberRepo = new BoardMemberRepository(tenantDb);

    const positionIds = new Set();

    // Get positions from UserPosition collection
    const userPositions = await userPositionRepo.findByUserId(userId, true);
    userPositions.forEach(up => {
      if (up.position_id) {
        const posId = up.position_id._id || up.position_id;
        if (posId) {
          positionIds.add(String(posId));
        }
      }
    });

    // Get position from board_members collection
    const orgObjectId = await this._getOrgObjectId();
    const boardMember = await boardMemberRepo.findByUserId(userId, orgObjectId);

    if (boardMember && boardMember.position_id) {
      const bmPosId = boardMember.position_id._id || boardMember.position_id;
      if (bmPosId) {
        positionIds.add(String(bmPosId));
      }
    }

    return [...positionIds];
  }

  /**
   * Check if a user can approve a step (by user_id or position_id)
   */
  _canUserApproveStep(step, userId, userPositionIds) {
    if (step.status !== 'pending') return false;

    // Direct user match
    if (step.approver_user_id && String(step.approver_user_id) === String(userId)) {
      return true;
    }

    // Position match: user holds the approver position (works even when approver_user_id is set)
    // This ensures position holders see approvals when a different user was pre-assigned
    if (step.approver_position_id) {
      const stepPosId = step.approver_position_id._id || step.approver_position_id;
      if (stepPosId && userPositionIds.includes(String(stepPosId))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get pending approvals for a user
   */
  async getPendingApprovalsForUser(userId) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get all position IDs this user holds
    const userPositionIds = await this._getUserPositionIds(userId);

    // Query by both user_id and position_ids
    const requests = await approvalRequestRepo.findPendingByApprover(userId, userPositionIds);

    // Also get pending rejection reviews for this user
    const pendingRejectionReviews = await approvalRequestRepo.findPendingRejectionReviews(userId);
    const rejectionReviewRequestIds = new Set(
      pendingRejectionReviews.map(r => String(r._id))
    );

    // Filter to only show steps that are pending for this user
    const approvalRequests = requests.map(request => {
      const userSteps = request.approval_steps.filter(step =>
        this._canUserApproveStep(step, userId, userPositionIds)
      );

      // For sequential, only show the first pending step
      if (request.approval_type === 'sequential') {
        const firstPendingIndex = request.approval_steps.findIndex(s => s.status === 'pending');
        if (firstPendingIndex >= 0) {
          const firstPendingStep = request.approval_steps[firstPendingIndex];
          if (this._canUserApproveStep(firstPendingStep, userId, userPositionIds)) {
            return {
              ...request.toObject(),
              current_step: firstPendingIndex,
              can_approve: true
            };
          }
        }
        return null;
      }

      return {
        ...request.toObject(),
        user_steps: userSteps,
        can_approve: userSteps.length > 0
      };
    }).filter(r => r !== null);

    // Add pending rejection reviews that aren't already in the list
    const existingRequestIds = new Set(approvalRequests.map(r => String(r._id)));
    const additionalRejectionReviews = pendingRejectionReviews
      .filter(r => !existingRequestIds.has(String(r._id)))
      .map(request => ({
        ...request.toObject(),
        can_approve: false, // User can't approve steps, but can review rejection
        has_pending_rejection_review: true
      }));

    return [...approvalRequests, ...additionalRejectionReviews];
  }

  /**
   * Forward a rejection for review to another workflow participant
   */
  async forwardRejectionForReview(approvalRequestId, stepIndex, rejectedBy, forwardToUserId, rejectionComments) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    // Get approval request
    const request = await approvalRequestRepo.findById(approvalRequestId);
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    // Validate that the rejector is not forwarding to themselves
    if (String(rejectedBy) === String(forwardToUserId)) {
      throw new AppError('Cannot forward rejection to yourself', 400, 'INVALID_FORWARD_USER');
    }

    // Validate that forwardToUser is a workflow participant
    const participants = await approvalRequestRepo.getApprovalWorkflowParticipants(approvalRequestId);
    const isParticipant = participants.some(p => String(p._id) === String(forwardToUserId));
    
    if (!isParticipant) {
      throw new AppError('Can only forward rejection to workflow participants', 400, 'INVALID_FORWARD_USER');
    }

    // Get step data for pre-fill
    const step = request.approval_steps[stepIndex];
    if (!step) {
      throw new AppError('Approval step not found', 404, 'STEP_NOT_FOUND');
    }

    // Create rejection review
    const rejectionReviewData = {
      rejected_by: rejectedBy,
      forwarded_to: forwardToUserId,
      step_index: stepIndex,
      rejection_comments: rejectionComments,
      review_status: 'pending',
      original_step_data: {
        level: step.level,
        approver_user_id: step.approver_user_id,
        approver_position_id: step.approver_position_id,
        approver_department_id: step.approver_department_id,
        rejection_reason: rejectionComments
      }
    };

    const updatedRequest = await approvalRequestRepo.createRejectionReview(approvalRequestId, rejectionReviewData);

    // Send notification to the user who needs to review the rejection
    try {
      await notificationRepo.create({
        org_id: request.org_id,
        user_id: forwardToUserId,
        type: 'approval',
        title: 'Rejection Review Required',
        message: `A rejection has been forwarded to you for review`,
        entity_type: request.entity_type,
        entity_id: request.entity_id,
        created_at: new Date()
      });
    } catch (notifError) {
      logError('Failed to send rejection review notification', { error: notifError });
    }

    logInfo('Rejection forwarded for review', {
      approvalRequestId,
      rejectedBy,
      forwardToUserId,
      stepIndex
    });

    return updatedRequest;
  }

  /**
   * Process rejection review (accept or reject the rejection)
   */
  async processRejectionReview(approvalRequestId, reviewerUserId, reviewAction, reviewComments) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    // Get approval request
    const request = await approvalRequestRepo.findById(approvalRequestId);
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    // Check status
    if (request.status !== 'pending_rejection_review') {
      throw new AppError('No active rejection review found', 400, 'NO_ACTIVE_REJECTION_REVIEW');
    }

    // Get current rejection review
    const currentReview = await approvalRequestRepo.getCurrentRejectionReview(approvalRequestId);
    if (!currentReview) {
      throw new AppError('Current rejection review not found', 404, 'REJECTION_REVIEW_NOT_FOUND');
    }

    // Verify reviewer is the forwarded_to user
    // Note: forwarded_to may be populated (Object) or just an ObjectId
    const forwardedToId = currentReview.forwarded_to?._id || currentReview.forwarded_to;
    if (String(forwardedToId) !== String(reviewerUserId)) {
      throw new AppError('You are not authorized to review this rejection', 403, 'UNAUTHORIZED');
    }

    // Verify review is still pending
    if (currentReview.review_status !== 'pending') {
      throw new AppError('This rejection review is already processed', 400, 'REVIEW_ALREADY_PROCESSED');
    }

    // Update rejection review
    const reviewData = {
      review_status: reviewAction === 'accept_rejection' ? 'accepted' : 'rejected',
      review_action: reviewAction,
      review_comments: reviewComments,
      reviewed_at: new Date()
    };

    await approvalRequestRepo.updateRejectionReview(
      approvalRequestId,
      currentReview._id,
      reviewData
    );

    // Clear current rejection review ID and update status
    // Business rules:
    // - accept_rejection -> resume workflow (back to pending)
    // - reject_rejection -> workflow is rejected
    const newStatus = reviewAction === 'accept_rejection' ? 'pending' : 'rejected';

    await approvalRequestRepo.update(approvalRequestId, {
      current_rejection_review_id: null,
      status: newStatus
    });

    // Send notification back to original rejector
    try {
      await notificationRepo.create({
        org_id: request.org_id,
        user_id: currentReview.rejected_by,
        type: 'approval',
        title: reviewAction === 'accept_rejection'
          ? 'Rejection Accepted'
          : 'Rejection Confirmed',
        message: reviewAction === 'accept_rejection'
          ? 'Your rejection has been reviewed and the workflow has resumed.'
          : 'Your rejection has been reviewed and the request is now fully rejected.',
        entity_type: request.entity_type,
        entity_id: request.entity_id,
        created_at: new Date()
      });
    } catch (notifError) {
      logError('Failed to send rejection review notification', { error: notifError });
    }

    logInfo('Rejection review processed', {
      approvalRequestId,
      reviewerUserId,
      reviewAction,
      newStatus
    });

    const updatedRequest = await approvalRequestRepo.findById(approvalRequestId);
    return updatedRequest;
  }

  /**
   * Create approval request for partner vetting
   */
  async createPartnerVettingApprovalRequest(partnerId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const partnerVettingRepo = await import('../repositories/partnerVettingRepository.js').then(m => m.PartnerVettingRepository);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get partner
    const Partner = tenantDb.model('PartnerVetting');
    const partner = await Partner.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }

    // Find matching approval rule (use amount 0 for partner_vetting, no amount-based rules)
    const { matrix, rule } = await this.findMatchingRule('partner_vetting', 0, orgObjectId);
    
    // Resolve approvers
    const approvers = await this.resolveApprovers(rule, orgObjectId);

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
      org_id: orgObjectId,
      request_type: 'partner_vetting',
      entity_id: partnerId,
      entity_type: 'partner',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Update partner with approval request reference
    await Partner.findByIdAndUpdate(partnerId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending'
    });

    logInfo('Partner vetting approval request created', {
      partnerId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Create approval request for funding agreement
   */
  async createFundingAgreementApprovalRequest(fundingAgreementId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get funding agreement
    const FundingAgreement = tenantDb.model('FundingAgreement');
    const fundingAgreement = await FundingAgreement.findById(fundingAgreementId);
    if (!fundingAgreement) {
      throw new AppError('Funding agreement not found', 404, 'FUNDING_AGREEMENT_NOT_FOUND');
    }

    // Find matching approval rule (use agreement amount for threshold matching)
    const agreementAmount = fundingAgreement.amount || 0;
    const { matrix, rule } = await this.findMatchingRule('funding_agreement', agreementAmount, orgObjectId);
    
    // Resolve approvers
    const approvers = await this.resolveApprovers(rule, orgObjectId);

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
      org_id: orgObjectId,
      request_type: 'funding_agreement',
      entity_id: fundingAgreementId,
      entity_type: 'funding_agreement',
      amount: agreementAmount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Update funding agreement with approval request reference
    await FundingAgreement.findByIdAndUpdate(fundingAgreementId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending'
    });

    logInfo('Funding agreement approval request created', {
      fundingAgreementId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Create approval request for project
   */
  async createProjectApprovalRequest(projectId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Get project
    const Project = tenantDb.model('ProjectRegister');
    const project = await Project.findById(projectId);
    if (!project) {
      throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }

    // Find matching approval rule (use project budget for threshold matching)
    const projectBudget = project.budget_total || 0;
    const { matrix, rule } = await this.findMatchingRule('project', projectBudget, orgObjectId);
    
    // Resolve approvers
    const approvers = await this.resolveApprovers(rule, orgObjectId);

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
      org_id: orgObjectId,
      request_type: 'project',
      entity_id: projectId,
      entity_type: 'project',
      amount: projectBudget,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Update project with approval request reference
    await Project.findByIdAndUpdate(projectId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending'
    });

    logInfo('Project approval request created', {
      projectId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }
}
