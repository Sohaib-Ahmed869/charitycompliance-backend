/**
 * Approval Workflow Service
 * 
 * Core business logic for approval workflows
 * Handles approver resolution, approval request creation, and approval processing
 */

import { getTenantConnection } from '../db/connectionManager.js';
import mongoose from 'mongoose';
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
import { DonorRepository } from '../repositories/donorRepository.js';
import { DocumentRepository } from '../repositories/documentRepository.js';
import { ProjectRegisterService } from './projectRegisterService.js';
import { AppError } from '../middleware/errorHandler.js';
import { ACTION_TO_CATEGORY, getDisplayName, getRedirectPath } from './workflowGuardService.js';
import { logError, logInfo } from '../utils/logger.js';
import emailService from './emailService.js';
import { notifyVolunteersForPolicy } from './volunteerPolicyNotifier.js';

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
    if (t === 'complaint_resolution') return 'complaint';
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
    // Only use workflows that are currently effective (within date range) and not revoked.
    const matrices = await approvalMatrixRepo.findEffectiveByOrgId(orgId, new Date());

    // Build the structured details payload the FE redirect dialog expects.
    const guardCategory = ACTION_TO_CATEGORY[normalizedActionType] || null;
    const guardDetails = {
      category: guardCategory,
      actionType: normalizedActionType,
      displayName: getDisplayName(guardCategory),
      redirectPath: getRedirectPath(guardCategory)
    };

    if (!matrices || matrices.length === 0) {
      throw new AppError(
        `No approval workflow is configured for ${guardDetails.displayName}. Please set one up before creating this request.`,
        400,
        'WORKFLOW_NOT_CONFIGURED',
        guardDetails
      );
    }

    let selectedMatrix = null;
    let selectedRule = null;
    let actionTypeHasAnyRule = false;

    for (const matrix of matrices) {
      for (const rule of matrix.rules) {
        if (!rule.is_active) continue;
        if (this._normalizeActionType(rule.action_type) !== normalizedActionType) continue;

        actionTypeHasAnyRule = true;

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

    // Legacy-data fallback: if no rule matched by action_type but a matrix exists
    // whose workflow_category corresponds to this action, use its first active rule.
    // Older onboarding seeds saved rule.action_type='other' even when the user
    // configured a real category — see the actionTypeMap fix in onboardingService.js.
    if (!selectedRule && guardCategory) {
      for (const matrix of matrices) {
        const matrixCat = String(matrix.workflow_category || '').toLowerCase().trim();
        if (matrixCat !== guardCategory) continue;
        for (const rule of matrix.rules) {
          if (!rule.is_active) continue;
          if (!Array.isArray(rule.requires_approval_from) || rule.requires_approval_from.length === 0) continue;
          actionTypeHasAnyRule = true;
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
    }

    // No matrix has any rule for this action type at all → same UX as "not configured".
    // (A tier-mismatch — rule exists but amount falls outside min/max — is a different
    // problem the user fixes by editing, so we keep NO_MATCHING_RULE for that.)
    if (!selectedRule && !actionTypeHasAnyRule) {
      throw new AppError(
        `No approval workflow is configured for ${guardDetails.displayName}. Please set one up before creating this request.`,
        400,
        'WORKFLOW_NOT_CONFIGURED',
        guardDetails
      );
    }

    if (!selectedRule) {
      throw new AppError(
        `Your ${guardDetails.displayName} workflow doesn't cover the amount ${amount}. Please edit the workflow's amount tiers.`,
        400,
        'NO_MATCHING_RULE',
        guardDetails
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

    // Send email notifications to approvers
    try {
      const userRepo = new UserRepository(tenantDb);
      const submitter = await userRepo.findById(submittedBy);
      const submitterName = submitter ? `${submitter.first_name} ${submitter.last_name}` : 'A user';

      for (const approver of approvers) {
        if (!approver.user_id) continue; // Skip if no user assigned yet
        
        const approverUser = await userRepo.findById(approver.user_id);
        if (!approverUser?.email) continue; // Skip if no email

        const approverName = `${approverUser.first_name} ${approverUser.last_name}`;
        
        await emailService.sendApprovalRequestEmail({
          to: approverUser.email,
          recipientName: approverName,
          approvalRequestId: approvalRequest._id.toString(),
          requestType: 'expense',
          entityTitle: `Expense: $${expense.amount}`,
          approvalLevel: approver.level,
          submitterName,
          approvalType: rule.approval_type
        });

        logInfo('Approval request email sent', {
          approverUserId: approver.user_id,
          approverEmail: approverUser.email,
          approvalRequestId: approvalRequest._id
        });
      }
    } catch (emailError) {
      logError('Failed to send approval request emails', {
        error: emailError.message,
        approvalRequestId: approvalRequest._id
      });
      // Don't throw - approval request was created successfully, email failure shouldn't block it
    }

    return approvalRequest;
  }

  /**
   * Map donor size to numeric amount for approval matrix matching
   * small=1, medium=2, large=3
   */
  _mapDonorSizeToAmount(size) {
    const sizeMap = {
      'small': 1,
      'medium': 2,
      'large': 3
    };
    return sizeMap[size] || 1;
  }

  /**
   * Create approval request for a donation (action_type: donation)
   */
  async createDonationApprovalRequest(donationId, submittedBy, amount) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    // Find matching approval rule for donation action_type
    const { matrix, rule } = await this.findMatchingRule('donation', amount || 0, orgObjectId);

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
      request_type: 'donation',
      entity_id: donationId,
      entity_type: 'donation',
      amount: amount || 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    logInfo('Donation approval request created', {
      donationId,
      amount,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Create approval request for a donation milestone (action_type: donation_milestone)
   */
  async createDonationMilestoneApprovalRequest(milestoneId, submittedBy, amount) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const { matrix, rule } = await this.findMatchingRule('donation_milestone', amount || 0, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);

    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'donation_milestone',
      entity_id: milestoneId,
      entity_type: 'donation_milestone',
      amount: amount || 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    return approvalRequest;
  }

  /**
   * Create approval request for a social media campaign (action_type: social_media_campaign)
   */
  async createSocialMediaCampaignApprovalRequest(campaignId, submittedBy, amount) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const { matrix, rule } = await this.findMatchingRule('social_media_campaign', amount || 0, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);

    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'social_media_campaign',
      entity_id: campaignId,
      entity_type: 'social_media_campaign',
      amount: amount || 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    return approvalRequest;
  }

  /**
   * Create approval request for a donor (action_type: donor)
   * Uses workflow_type (small/medium/large) from donor size
   */
  async createDonorApprovalRequest(donorId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const donorRepo = new DonorRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);

    // Get donor
    const donor = await donorRepo.findById(donorId);
    if (!donor) {
      throw new AppError('Donor not found', 404, 'DONOR_NOT_FOUND');
    }

    // Map donor size to amount for matching (small=1, medium=2, large=3)
    const donorAmount = this._mapDonorSizeToAmount(donor.size || 'small');

    // Find matching approval rule for donor action_type
    const { matrix, rule } = await this.findMatchingRule('donor', donorAmount, orgObjectId);
    
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
    // Use donorAmount (1/2/3) so the required "amount" field is satisfied,
    // even though this is not a literal currency amount.
    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'donor',
      entity_id: donorId,
      entity_type: 'donor',
      amount: donorAmount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Update donor with approval request reference
    await donorRepo.update(donorId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending_approval'
    });

    logInfo('Donor approval request created', {
      donorId,
      donorSize: donor.size,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Map grant size to numeric amount for approval matrix matching
   * small=1, medium=2, large=3
   */
  _mapGrantSizeToAmount(size) {
    const sizeMap = {
      'small': 1,
      'medium': 2,
      'large': 3
    };
    return sizeMap[size] || 1;
  }

  /**
   * Create approval request for a grant (action_type: grant)
   * Uses workflow_type (small/medium/large) from grant size
   */
  async createGrantApprovalRequest(grantId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);

    // Get grant (assuming a Grant model exists)
    const Grant = tenantDb.model('Grant');
    const grant = await Grant.findById(grantId);
    if (!grant) {
      throw new AppError('Grant not found', 404, 'GRANT_NOT_FOUND');
    }

    // Map grant size to amount for matching (small=1, medium=2, large=3)
    const grantAmount = this._mapGrantSizeToAmount(grant.size || 'small');

    // Find matching approval rule for grant action_type
    const { matrix, rule } = await this.findMatchingRule('grant', grantAmount, orgObjectId);
    
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
      request_type: 'grant',
      entity_id: grantId,
      entity_type: 'grant',
      amount: grantAmount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Update grant with approval request reference
    await Grant.findByIdAndUpdate(grantId, {
      approval_matrix_id: matrix._id,
      approval_request_id: approvalRequest._id,
      status: 'pending_approval'
    });

    logInfo('Grant approval request created', {
      grantId,
      grantSize: grant.size,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Find an active risk-management matrix/rule by priority (low/moderate/high).
   * Looks at the matrix-level `workflow_type` / `priority_level` rather than
   * min/max amount, so the selection is unambiguous regardless of any legacy
   * amount-based configuration.
   */
  async findRiskMatrixByPriority(priority, orgId) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);

    // "medium" and "moderate" both show up in UIs; normalise to the matrix values.
    const want = String(priority || '').toLowerCase();
    const workflowTypes = want === 'moderate'
      ? ['moderate', 'medium']
      : want === 'high'
        ? ['high']
        : ['low'];

    const matrices = await approvalMatrixRepo.findEffectiveByOrgId(orgId, new Date());
    if (!matrices || matrices.length === 0) {
      throw new AppError('No approval workflow is currently effective.', 400, 'NO_APPROVAL_MATRIX');
    }

    const priorityMatch = (m) => {
      const t = String(m.workflow_type || '').toLowerCase();
      const pl = String(m.priority_level || '').toLowerCase();
      return workflowTypes.includes(t) || workflowTypes.includes(pl);
    };

    // Prefer risk-management matrices that match the priority exactly.
    const riskMatrices = matrices.filter((m) => {
      const cat = String(m.workflow_category || '').toLowerCase();
      if (cat && cat !== 'risk_management') return false;
      return (m.rules || []).some((r) => r.is_active && this._normalizeActionType(r.action_type) === 'risk');
    });

    const matched = riskMatrices.find(priorityMatch);
    const fallback = riskMatrices[0];
    const selectedMatrix = matched || fallback || null;
    if (!selectedMatrix) {
      throw new AppError(
        `No risk approval workflow configured for priority "${priority}".`,
        400,
        'NO_MATCHING_RULE'
      );
    }
    const selectedRule = (selectedMatrix.rules || []).find(
      (r) => r.is_active && this._normalizeActionType(r.action_type) === 'risk'
    );
    if (!selectedRule) {
      throw new AppError(
        `No active risk rule in the matched matrix for priority "${priority}".`,
        400,
        'NO_MATCHING_RULE'
      );
    }
    return { matrix: selectedMatrix, rule: selectedRule };
  }

  /**
   * Create a pre-approval request whose ONLY step is the department head.
   *
   * The risk is not yet assigned a severity — the HoD sets it during approval,
   * and only then do we attach the severity-matched workflow steps. This avoids
   * defaulting every risk to "low" and firing the low-priority chain prematurely.
   */
  async createRiskHodAssessmentRequest(riskId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const riskRepo = new RiskRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const boardMemberRepo = new BoardMemberRepository(tenantDb);

    const risk = await riskRepo.findById(riskId);
    if (!risk) {
      throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
    }

    const submittingUserId =
      submittedBy ||
      (risk.submitted_by && typeof risk.submitted_by === 'object' ? risk.submitted_by._id : risk.submitted_by);

    const departmentId = risk.department_id?._id || risk.department_id;
    if (!departmentId) {
      throw new AppError(
        'Risks must be assigned to a department so the department head can assess severity.',
        400,
        'RISK_NO_DEPARTMENT'
      );
    }

    const deptHead = await boardMemberRepo.findDepartmentHeadByDepartmentId(orgObjectId, departmentId);
    if (!deptHead) {
      throw new AppError(
        'No head of department is configured for this department. Set one in Responsible People before submitting risks.',
        400,
        'NO_DEPARTMENT_HEAD'
      );
    }

    const headUserId = deptHead.user_id?._id || deptHead.user_id;
    const approvalSteps = [{
      level: 1,
      approver_user_id: headUserId || undefined,
      approver_position_id: deptHead.position_id?._id || deptHead.position_id,
      approver_department_id: departmentId,
      is_department_head: true,
      status: 'pending'
    }];

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'risk',
      entity_id: riskId,
      entity_type: 'risk',
      amount: 0,
      // matrix_id intentionally left null — it is assigned once HoD chooses severity.
      approval_matrix_id: null,
      approval_type: 'sequential',
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittingUserId,
      metadata: { risk_hod_assessment_only: true }
    });

    await riskRepo.update(riskId, {
      approval_request_id: approvalRequest._id,
      approval_matrix_id: null,
      status: 'pending',
      submitted_by: submittingUserId
    });

    logInfo('Risk HoD severity-assessment request created', {
      riskId,
      approvalRequestId: approvalRequest._id,
      departmentId: String(departmentId)
    });

    // Notify ONLY the department head — no other approvers are attached yet.
    try {
      if (headUserId) {
        const userRepo = new UserRepository(tenantDb);
        const submitter = await userRepo.findById(submittingUserId);
        const submitterName = submitter ? `${submitter.first_name} ${submitter.last_name}` : 'A user';
        const head = await userRepo.findById(headUserId);
        if (head?.email) {
          await emailService.sendApprovalRequestEmail({
            to: head.email,
            recipientName: `${head.first_name} ${head.last_name}`.trim() || 'Department head',
            approvalRequestId: approvalRequest._id.toString(),
            requestType: 'risk',
            entityTitle: `Risk: ${risk.title}`,
            approvalLevel: 1,
            submitterName,
            approvalType: 'sequential'
          });
        }
      }
    } catch (emailErr) {
      logError('Failed to send HoD risk-assessment email', {
        error: emailErr?.message,
        approvalRequestId: approvalRequest._id
      });
    }

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

    // Send email notifications to approvers
    try {
      const userRepo = new UserRepository(tenantDb);
      const submitter = await userRepo.findById(submittingUserId);
      const submitterName = submitter ? `${submitter.first_name} ${submitter.last_name}` : 'A user';

      for (const step of approvalRequest.approval_steps) {
        if (!step.approver_user_id) continue; // Skip if no user assigned yet
        
        const approverUser = await userRepo.findById(step.approver_user_id);
        if (!approverUser?.email) continue; // Skip if no email

        const approverName = `${approverUser.first_name} ${approverUser.last_name}`;
        
        await emailService.sendApprovalRequestEmail({
          to: approverUser.email,
          recipientName: approverName,
          approvalRequestId: approvalRequest._id.toString(),
          requestType: 'risk',
          entityTitle: `Risk: ${risk.title}`,
          approvalLevel: step.level,
          submitterName,
          approvalType: rule.approval_type
        });

        logInfo('Risk approval request email sent', {
          approverUserId: step.approver_user_id,
          approvalRequestId: approvalRequest._id
        });
      }
    } catch (emailError) {
      logError('Failed to send risk approval emails', {
        error: emailError.message,
        approvalRequestId: approvalRequest._id
      });
    }

    return approvalRequest;
  }

  /**
   * Create approval request for a policy (action_type: policy)
   * Policies follow the normal approval matrix workflow only (no department head pre-approval).
   */
  async createPolicyApprovalRequest(policyId, submittedBy, changeControlNote = null) {
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
      submitted_by: submittedBy,
      change_control: changeControlNote?.trim?.() ? changeControlNote.trim() : null
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

    // Send email notifications to approvers
    try {
      const userRepo = new UserRepository(tenantDb);
      const submitter = await userRepo.findById(submittedBy);
      const submitterName = submitter ? `${submitter.first_name} ${submitter.last_name}` : 'A user';

      for (const step of approvalRequest.approval_steps) {
        if (!step.approver_user_id) continue; // Skip if no user assigned yet
        
        const approverUser = await userRepo.findById(step.approver_user_id);
        if (!approverUser?.email) continue; // Skip if no email

        const approverName = `${approverUser.first_name} ${approverUser.last_name}`;
        
        await emailService.sendApprovalRequestEmail({
          to: approverUser.email,
          recipientName: approverName,
          approvalRequestId: approvalRequest._id.toString(),
          requestType: 'policy',
          entityTitle: `Policy: ${policy.title}`,
          approvalLevel: step.level,
          submitterName,
          approvalType: rule.approval_type
        });

        logInfo('Policy approval request email sent', {
          approverUserId: step.approver_user_id,
          approvalRequestId: approvalRequest._id
        });
      }
    } catch (emailError) {
      logError('Failed to send policy approval emails', {
        error: emailError.message,
        approvalRequestId: approvalRequest._id
      });
    }

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
   * Create approval request for a BCP authority transfer.
   * Uses the approval matrix referenced by workflow_matrix_id on the transfer.
   */
  async createEmergencyTransferApprovalRequest(transferId, matrixId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);

    const matrix = await approvalMatrixRepo.findById(matrixId);
    if (!matrix) {
      throw new AppError('Approval matrix not found', 404, 'MATRIX_NOT_FOUND');
    }

    const rule = (matrix.rules || []).find(r => r.is_active && this._normalizeActionType(r.action_type) === 'emergency');
    if (!rule) {
      throw new AppError('No active emergency rule found in the selected workflow', 400, 'NO_MATCHING_RULE');
    }

    const approvers = [];
    for (const cfg of rule.requires_approval_from) {
      let userIds = [];
      if (cfg.user_id) {
        userIds = [cfg.user_id];
      } else if (cfg.position_id) {
        userIds = await userPositionRepo.findUsersByPositionId(cfg.position_id);
      }
      if (userIds.length > 0) {
        userIds.forEach(uid => approvers.push({
          user_id: uid,
          position_id: cfg.position_id || null,
          department_id: cfg.department_id || null,
          level: cfg.approval_level
        }));
      } else {
        approvers.push({
          user_id: null,
          position_id: cfg.position_id || null,
          department_id: cfg.department_id || null,
          level: cfg.approval_level
        });
      }
    }
    approvers.sort((a, b) => a.level - b.level);

    const approvalSteps = approvers.map(a => ({
      level: a.level,
      approver_user_id: a.user_id || undefined,
      approver_position_id: a.position_id,
      approver_department_id: a.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'emergency',
      entity_id: transferId,
      entity_type: 'authority_transfer',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    logInfo('Emergency transfer approval request created', {
      transferId,
      approvalRequestId: approvalRequest._id,
      approversCount: approvers.length
    });

    return approvalRequest;
  }

  /**
   * Process approval (approve or reject)
   */
  async processApproval(
    approvalRequestId,
    stepIndex,
    userId,
    decision,
    comments = null,
    ipAddress = null,
    userAgent = null,
    acknowledgement = null,
    signatureData = null
  ) {
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

    // If there is a pending escalation for this step, block decisions until opinion is received
    const hasPendingEscalation = (request.escalations || []).some(
      (e) => e.step_index === stepIndex && e.status === 'pending'
    );
    if (hasPendingEscalation) {
      throw new AppError(
        'This step has a pending escalation. Wait for the opinion before approving or declining.',
        400,
        'STEP_ESCALATED_PENDING'
      );
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
    console.log('[Approval] acknowledgement received:', JSON.stringify(acknowledgement));
    if (acknowledgement) {
      if (acknowledgement.note) {
        updateData.acknowledgement_note = acknowledgement.note;
      }
      if (acknowledgement.files && Array.isArray(acknowledgement.files) && acknowledgement.files.length > 0) {
        updateData.acknowledgement_files = acknowledgement.files;
        console.log('[Approval] Saving acknowledgement_files:', acknowledgement.files.length, 'files');
      } else {
        console.log('[Approval] No files in acknowledgement. files field:', acknowledgement.files);
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

    // Determine if this decision will complete the workflow (all approvals received)
    const allStepsCurrent = request.approval_steps || [];
    const hypotheticalSteps = allStepsCurrent.map((s, idx) => {
      const plain = s.toObject ? s.toObject() : { ...s };
      if (idx === stepIndex) {
        plain.status = decision;
      }
      return plain;
    });

    let wouldAllApproved = false;
    if (decision === 'approved') {
      if (request.approval_type === 'any') {
        wouldAllApproved = hypotheticalSteps.some((s) => s.status === 'approved');
      } else if (request.approval_type === 'parallel') {
        wouldAllApproved = hypotheticalSteps.every(
          (s) => s.status === 'approved' || s.status === 'rejected'
        ) && !hypotheticalSteps.some((s) => s.status === 'rejected');
      } else if (request.approval_type === 'sequential') {
        wouldAllApproved = hypotheticalSteps.every((s) => s.status === 'approved');
      }
    }

    // If this is the final approval, require an e‑signature
    if (wouldAllApproved && decision === 'approved') {
      if (!signatureData || typeof signatureData !== 'string' || !signatureData.trim()) {
        throw new AppError(
          'E‑signature is required to complete final approval',
          400,
          'MISSING_E_SIGNATURE'
        );
      }
      updateData.signature_data = signatureData;
    } else if (signatureData) {
      // Non‑final steps may optionally store a signature without enforcing it
      updateData.signature_data = signatureData;
    }

    await approvalRequestRepo.updateApprovalStep(approvalRequestId, stepIndex, updateData);

    // Check if all approvals are complete (using updated request)
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

      // Send rejection notification email to submitter
      try {
        const userRepo = new UserRepository(tenantDb);
        const decidingUser = await userRepo.findById(userId);
        const deciderName = decidingUser ? `${decidingUser.first_name} ${decidingUser.last_name}` : 'An approver';
        
        const submitter = await userRepo.findById(request.submitted_by);
        if (submitter?.email) {
          const typeLabel = {
            expense: 'Expense',
            risk: 'Risk',
            policy: 'Policy',
            purchase: 'Purchase',
            grant: 'Grant',
            funding: 'Funding Agreement'
          }[request.entity_type] || request.entity_type;

          const entityTitle = request.entity_type === 'expense' 
            ? `$${(await expenseRepo.findById(request.entity_id))?.amount || 'N/A'}`
            : (await (request.entity_type === 'risk' ? riskRepo.findById(request.entity_id) : null))?.title || 'N/A';

          await emailService.sendApprovalDecisionEmail({
            to: submitter.email,
            recipientName: `${submitter.first_name} ${submitter.last_name}`,
            approvalRequestId: approvalRequestId.toString(),
            requestType: request.entity_type,
            entityTitle: `${typeLabel}: ${entityTitle}`,
            decision: 'rejected',
            decidedByName: deciderName,
            comments,
            remainingSteps: undefined
          });

          logInfo('Rejection notification email sent', {
            submitterId: request.submitted_by,
            approvalRequestId
          });
        }
      } catch (emailError) {
        logError('Failed to send rejection notification email', {
          error: emailError.message,
          approvalRequestId
        });
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

      // If this approval corresponds to a project refund sign-off, close the project after approval.
      // We correlate using ProjectRefund.internal_approval_request_id.
      try {
        const { ProjectRefundRepository } = await import('../repositories/projectRefundRepository.js');
        const refundRepo = new ProjectRefundRepository(tenantDb);
        const refund = await refundRepo.ProjectRefund
          .findOne({ internal_approval_request_id: approvalRequestId })
          .lean();

        if (refund && refund.project_id) {
          await refundRepo.updateById(refund._id, {
            status: 'completed',
            internal_approved_at: new Date()
          });

          const projectRepo = new ProjectRegisterRepository(tenantDb);
          const projId = refund.project_id?._id || refund.project_id;

          const existingProject = await projectRepo.findById(projId).catch(() => null);
          const existingMeta = existingProject?.metadata && typeof existingProject.metadata === 'object'
            ? existingProject.metadata
            : {};

          await projectRepo.update(projId, {
            status: 'closed',
            delivery_status: 'delivered_and_handed_off',
            metadata: {
              ...existingMeta,
              project_closed_at: new Date(),
              project_closed_via: 'refund_receipts_approval',
              project_closed_by: userId,
              refund_completed_at: new Date(),
              refund_id: refund._id
            }
          });
        }
      } catch (err) {
        // Do not fail approval completion if close-out fails; log and continue.
        logError('Failed to close project after refund approval', { approvalRequestId, error: err?.message });
      }

      if (request.entity_type === 'expense') {
        await expenseRepo.updateStatus(request.entity_id, 'approved', { approved_at: new Date() });
        logInfo('Expense status updated from approval', { approvalRequestId, entityId: request.entity_id });

        // Notify submitter to assign a payment member
        try {
          const exp = await expenseRepo.findById(request.entity_id);
          const submitterId = exp?.submitted_by?._id || exp?.submitted_by;
          if (submitterId) {
            const notificationRepo = new NotificationRepository(tenantDb);
            await notificationRepo.create({
              user_id: submitterId,
              type: 'expense_payment_assignment_required',
              title: 'Expense approved — assign payment team',
              message: 'Your expense was approved. Please assign a payment processor (adds payment details) and a payment reviewer (reviews and accepts).',
              link: `/expenses/${request.entity_id}#payment-section`,
              related_entity_id: request.entity_id,
              related_entity_type: 'expense',
              created_at: new Date()
            });
          }
        } catch (err) {
          logError('Failed to create expense payment assignment notification', { error: err?.message, expenseId: request.entity_id });
        }
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
        // Fan out policy-ack emails to volunteers now that the policy is active.
        notifyVolunteersForPolicy(this.orgId, tenantDb, updatedPolicy).catch(() => {});
      } else if (request.entity_type === 'donor') {
        const donorRepo = new DonorRepository(tenantDb);
        await donorRepo.update(request.entity_id, {
          status: 'approved',
          approved_for_kyc: true,
          kyc_status: 'not_started',
          aml_screening_status: 'not_started'
        });
        logInfo('Donor status updated from approval', {
          approvalRequestId,
          entityId: request.entity_id
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
      } else if (request.entity_type === 'authority_transfer') {
        try {
          const { BcpService } = await import('./bcpService.js');
          const bcpService = new BcpService(this.orgId);
          await bcpService.approveAuthorityTransfer(request.entity_id, true, 'Workflow approved', userId, 'workflow');
          logInfo('Authority transfer activated from workflow approval', { approvalRequestId, entityId: request.entity_id });
        } catch (transferErr) {
          logError('Error activating authority transfer after workflow approval', {
            approvalRequestId,
            entityId: request.entity_id,
            error: transferErr.message
          });
        }
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
        emergency: 'Emergency Authority Transfer',
        complaint_resolution: 'Complaint Resolution Workflow',
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

      // Send approval email to submitter
      try {
        const userRepo = new UserRepository(tenantDb);
        const submitter = await userRepo.findById(submittedById);
        if (submitter?.email) {
          const typeLabel = {
            expense: 'Expense',
            risk: 'Risk',
            policy: 'Policy',
            purchase: 'Purchase',
            grant: 'Grant',
            funding: 'Funding Agreement',
            donation: 'Donation',
            contract: 'Contract',
            complaint: 'Complaint'
          }[request.entity_type] || request.entity_type;

          let entityTitle = 'N/A';
          if (request.entity_type === 'expense') {
            const exp = await expenseRepo.findById(request.entity_id);
            entityTitle = `$${exp?.amount || 'N/A'}`;
          } else if (request.entity_type === 'policy') {
            const policyRepo = new PolicyRepository(tenantDb);
            const policy = await policyRepo.findById(request.entity_id);
            entityTitle = policy?.title || 'Policy';
          } else if (request.entity_type === 'risk') {
            const risk = await riskRepo.findById(request.entity_id);
            entityTitle = risk?.title || 'Risk';
          }

          const lastApproverId = (finalRequest?.approval_steps || allSteps || []).length > 0 
            ? (finalRequest?.approval_steps || allSteps || [])[(finalRequest?.approval_steps || allSteps || []).length - 1].approver_user_id
            : null;
          const lastApprover = lastApproverId ? await userRepo.findById(lastApproverId) : null;
          const lastApproverName = lastApprover 
            ? `${lastApprover.first_name} ${lastApprover.last_name}`
            : 'An approver';

          await emailService.sendApprovalDecisionEmail({
            to: submitter.email,
            recipientName: `${submitter.first_name} ${submitter.last_name}`,
            approvalRequestId: approvalRequestId.toString(),
            requestType: request.entity_type,
            entityTitle: `${typeLabel}: ${entityTitle}`,
            decision: 'approved',
            decidedByName: lastApproverName,
            comments: 'Your request has been fully approved by all required approvers.',
            remainingSteps: 0
          });

          logInfo('Approval notification email sent', {
            submitterId,
            approvalRequestId
          });
        }
      } catch (emailError) {
        logError('Failed to send approval notification email', {
          error: emailError.message,
          approvalRequestId
        });
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

    // Get positions from ALL active board_member records (user may hold multiple positions)
    const orgObjectId = await this._getOrgObjectId();
    const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userId, orgObjectId);

    if (allBoardMembers && allBoardMembers.length > 0) {
      for (const bm of allBoardMembers) {
        const bmPosId = bm.position_id?._id || bm.position_id;
        if (bmPosId) {
          positionIds.add(String(bmPosId));
        }
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
    const stepApproverUserId = step.approver_user_id?._id || step.approver_user_id;
    if (stepApproverUserId && String(stepApproverUserId) === String(userId)) {
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

    // Also get approvals where user has a pending escalation (opinion requested)
    const pendingEscalations = await approvalRequestRepo.findPendingEscalationsForUser(userId);

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
      .map(request => {
        existingRequestIds.add(String(request._id));
        return {
          ...request.toObject(),
          can_approve: false, // User can't approve steps, but can review rejection
          has_pending_rejection_review: true
        };
      });

    // Add pending escalations (opinion requested) that aren't already in the list
    const additionalEscalations = pendingEscalations
      .filter(r => !existingRequestIds.has(String(r._id)))
      .map(request => ({
        ...request.toObject(),
        can_approve: false,
        has_pending_escalation: true
      }));

    return [...approvalRequests, ...additionalRejectionReviews, ...additionalEscalations];
  }

  /**
   * Forward a rejection for review to another workflow participant
   */
  async forwardRejectionForReview(approvalRequestId, stepIndex, rejectedBy, forwardToUserId, rejectionComments, acknowledgement = null) {
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
      rejection_files: (acknowledgement?.files || []).map(f => ({
        name: f.name || '',
        size: f.size || 0,
        file_type: f.type || f.file_type || '',
        url: f.url || '',
        key: f.key || ''
      })),
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
   * Escalate a step to another user for their opinion (comments/files) without changing approver
   */
  async escalateForOpinion(approvalRequestId, stepIndex, escalatedByUserId, escalateToUserId, comments, files = []) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const request = await approvalRequestRepo.findById(approvalRequestId);
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    const steps = request.approval_steps || [];
    if (!steps[stepIndex]) {
      throw new AppError('Approval step not found', 404, 'APPROVAL_STEP_NOT_FOUND');
    }

    // Create escalation entry
    const escalation = {
      step_index: stepIndex,
      escalated_by: escalatedByUserId,
      escalated_to: escalateToUserId,
      status: 'pending',
      request_comments: comments || null,
      request_files: (files || []).map((f) => ({
        name: f.name || '',
        size: f.size || 0,
        file_type: f.file_type || f.type || '',
        url: f.url || '',
        key: f.key || ''
      })),
      comments: null,
      files: [],
      created_at: new Date(),
      responded_at: null
    };

    const updated = await approvalRequestRepo.updateWithOps(approvalRequestId, {
      $push: { escalations: escalation }
    });

    // Notify escalated user
    try {
      await notificationRepo.create({
        user_id: escalateToUserId,
        type: 'approval_pending',
        title: 'Opinion requested on workflow',
        message: 'A workflow approver has requested your input before they decide.',
        link: `/approvals/${approvalRequestId}`,
        related_entity_id: approvalRequestId,
        related_entity_type: 'approval_request',
        read: false,
        created_at: new Date()
      });

      // Send escalation email to the user being asked for opinion
      try {
        const userRepo = new UserRepository(tenantDb);
        const escalatedUser = await userRepo.findById(escalateToUserId);
        const escalatingUser = await userRepo.findById(escalatedByUserId);
        
        if (escalatedUser?.email && escalatingUser) {
          const escalatedByName = `${escalatingUser.first_name} ${escalatingUser.last_name}`;
          const escalatedToName = `${escalatedUser.first_name} ${escalatedUser.last_name}`;

          const typeLabel = {
            expense: 'Expense',
            risk: 'Risk',
            policy: 'Policy',
            purchase: 'Purchase',
            grant: 'Grant',
            funding: 'Funding Agreement',
            donation: 'Donation',
            contract: 'Contract',
            complaint: 'Complaint'
          }[request.entity_type] || request.entity_type;

          await emailService.sendEscalationRequestEmail({
            to: escalatedUser.email,
            recipientName: escalatedToName,
            approvalRequestId: approvalRequestId.toString(),
            requestType: request.entity_type,
            entityTitle: `${typeLabel}: Unknown`, // We don't have entity info easily, keeping generic
            escalatedByName,
            requestComments: comments
          });

          logInfo('Escalation request email sent', {
            escalationId: escalation._id,
            escalatedToUserId,
            approvalRequestId
          });
        }
      } catch (emailError) {
        logError('Failed to send escalation request email', {
          error: emailError.message,
          approvalRequestId
        });
      }
    } catch (err) {
      logError('Failed to create escalation notification', { error: err });
    }

    return updated;
  }

  /**
   * Respond to an escalation (add opinion and optional files)
   */
  async respondToEscalation(approvalRequestId, escalationId, responderUserId, comments, files = []) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const request = await approvalRequestRepo.findById(approvalRequestId);
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    const escalation = (request.escalations || []).id(escalationId);
    if (!escalation) {
      throw new AppError('Escalation not found', 404, 'ESCALATION_NOT_FOUND');
    }

    // Only the intended user can respond (handle both populated and unpopulated escalated_to)
    const escalatedToId = escalation.escalated_to?._id || escalation.escalated_to;
    if (!escalatedToId || String(escalatedToId) !== String(responderUserId)) {
      throw new AppError('You are not authorized to respond to this escalation', 403, 'UNAUTHORIZED');
    }

    if (escalation.status === 'responded') {
      throw new AppError('Escalation already responded to', 400, 'ESCALATION_ALREADY_RESPONDED');
    }

    escalation.status = 'responded';
    escalation.comments = comments;
    escalation.responded_at = new Date();
    escalation.files = (files || []).map((f) => ({
      name: f.name || '',
      size: f.size || 0,
      file_type: f.file_type || f.type || '',
      url: f.url || '',
      key: f.key || ''
    }));

    await request.save();

    // Notify original approver that opinion is ready
    try {
      await notificationRepo.create({
        user_id: escalation.escalated_by,
        type: 'approval_pending',
        title: 'Escalation response received',
        message: 'The person you escalated to has added their opinion. You can now decide on the workflow.',
        link: `/approvals/${approvalRequestId}`,
        related_entity_id: approvalRequestId,
        related_entity_type: 'approval_request',
        read: false,
        created_at: new Date()
      });
    } catch (err) {
      logError('Failed to create escalation response notification', { error: err });
    }

    return request;
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

    if (reviewAction === 'accept_rejection') {
      // Uphold decline: return to submitter for resubmission. Save current attempt to history.
      const steps = request.approval_steps || [];
      const stepsSnapshot = steps.map((s) => {
        const plain = s.toObject ? s.toObject() : { ...s };
        return plain;
      });
      const attemptNum = (request.previous_attempts?.length || 0) + 1;

      await approvalRequestRepo.updateWithOps(approvalRequestId, {
        $set: {
          current_rejection_review_id: null,
          status: 'returned_for_resubmission'
        },
        $push: {
          previous_attempts: {
            attempt_number: attemptNum,
            steps_snapshot: stepsSnapshot,
            saved_at: new Date(),
            reason: 'rejection_upheld'
          }
        }
      });

      // For policies: update policy status so it shows in Policies & Procedures
      if (request.entity_type === 'policy') {
        try {
          const policyRepo = new PolicyRepository(tenantDb);
          await policyRepo.update(request.entity_id, { status: 'resubmission_required' });
          logInfo('Policy status updated to resubmission_required', { policyId: request.entity_id });
        } catch (policyErr) {
          logError('Failed to update policy status for resubmission', { error: policyErr });
        }
      }
    } else {
      // reject_rejection: Override decline — resume workflow at the same step (decliner's step goes back to pending)
      const stepIndex = currentReview.step_index;
      const steps = request.approval_steps || [];
      const newSteps = steps.map((s, idx) => {
        const plain = s.toObject ? s.toObject() : { ...s };
        if (idx !== stepIndex) return plain;
        return {
          ...plain,
          status: 'pending',
          approved_at: null,
          rejected_at: null,
          rejection_reason: null,
          comments: null,
          acknowledgement_note: null,
          acknowledgement_files: [],
          ip_address: null,
          user_agent: null
        };
      });
      await approvalRequestRepo.update(approvalRequestId, {
        current_rejection_review_id: null,
        status: 'pending',
        approval_steps: newSteps
      });
    }

    // Send notification back to original rejector
    try {
      const submittedById = request.submitted_by?._id || request.submitted_by;
      const approvalLink = `/approvals/${approvalRequestId}`;

      await notificationRepo.create({
        user_id: currentReview.rejected_by,
        type: 'workflow_rejected',
        title: reviewAction === 'accept_rejection'
          ? 'Rejection Accepted'
          : 'Rejection Overridden',
        message: reviewAction === 'accept_rejection'
          ? 'Your decline has been upheld. The submitter will edit and resubmit.'
          : 'Your decline was overridden. The workflow has resumed.',
        link: approvalLink,
        related_entity_id: approvalRequestId,
        related_entity_type: 'approval_request',
        created_at: new Date()
      });
      if (reviewAction === 'accept_rejection') {
        await notificationRepo.create({
          user_id: submittedById,
          type: 'returned_for_resubmission',
          title: 'Returned for Resubmission',
          message: 'Your request was declined and the decline was upheld. Please review comments, make changes if needed, and resubmit.',
          link: approvalLink,
          related_entity_id: approvalRequestId,
          related_entity_type: 'approval_request',
          created_at: new Date()
        });

        // Send email for policy resubmission
        if (request.entity_type === 'policy') {
          try {
            const submitter = request.submitted_by;
            const policyRepo = new PolicyRepository(tenantDb);
            const policy = await policyRepo.findById(request.entity_id);
            const submitterEmail = submitter?.email;
            const submitterName = [submitter?.first_name, submitter?.last_name].filter(Boolean).join(' ') || 'there';
            const policyTitle = policy?.title || 'Policy';
            if (submitterEmail) {
              await emailService.sendPolicyResubmissionRequiredEmail({
                to: submitterEmail,
                recipientName: submitterName,
                policyTitle,
                approvalRequestId
              });
            }
          } catch (emailErr) {
            logError('Failed to send policy resubmission email', { error: emailErr });
          }
        }
      }
    } catch (notifError) {
      logError('Failed to send rejection review notification', { error: notifError });
    }

    logInfo('Rejection review processed', {
      approvalRequestId,
      reviewerUserId,
      reviewAction,
      newStatus: reviewAction === 'accept_rejection' ? 'returned_for_resubmission' : 'pending'
    });

    const updatedRequest = await approvalRequestRepo.findById(approvalRequestId);
    return updatedRequest;
  }

  /**
   * Resubmit approval request (submitter re-runs workflow after decline was upheld)
   */
  async resubmitForApproval(approvalRequestId, submitterUserId, changeControlNote = null) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const request = await approvalRequestRepo.findById(approvalRequestId);
    if (!request) {
      throw new AppError('Approval request not found', 404, 'APPROVAL_REQUEST_NOT_FOUND');
    }

    if (request.status !== 'returned_for_resubmission') {
      throw new AppError('Request is not in resubmission state', 400, 'INVALID_STATUS');
    }

    const submittedById = request.submitted_by?._id || request.submitted_by;
    if (String(submittedById) !== String(submitterUserId)) {
      throw new AppError('Only the submitter can resubmit', 403, 'UNAUTHORIZED');
    }

    const steps = request.approval_steps || [];
    // Build fresh step objects (no _id) so the workflow truly restarts from step 1
    const newSteps = steps.map((s) => {
      const plain = s.toObject ? s.toObject() : { ...s };
      return {
        level: plain.level,
        approver_user_id: plain.approver_user_id,
        approver_position_id: plain.approver_position_id,
        approver_department_id: plain.approver_department_id,
        is_department_head: plain.is_department_head ?? false,
        status: 'pending'
      };
    });

    // If submitter provided a change control note, attach it to the latest previous_attempt
    let updatedPreviousAttempts = request.previous_attempts || [];
    if (changeControlNote && updatedPreviousAttempts.length > 0) {
      const lastIdx = updatedPreviousAttempts.length - 1;
      const last = updatedPreviousAttempts[lastIdx];
      const plainLast = last?.toObject ? last.toObject() : { ...last };
      plainLast.change_control = changeControlNote;
      updatedPreviousAttempts = updatedPreviousAttempts.map((att, idx) => {
        if (idx !== lastIdx) return att;
        return plainLast;
      });
    }

    const updateOps = {
      $set: {
        status: 'pending',
        approval_steps: newSteps,
        current_rejection_review_id: null,
        completed_at: null,
        change_control: changeControlNote?.trim?.() ? changeControlNote.trim() : null
      }
    };
    if (changeControlNote && updatedPreviousAttempts.length > 0) {
      updateOps.$set.previous_attempts = updatedPreviousAttempts;
    }

    await approvalRequestRepo.updateWithOps(approvalRequestId, updateOps);

    // For policies: set back to under_review when workflow is re-running
    if (request.entity_type === 'policy') {
      try {
        const policyRepo = new PolicyRepository(tenantDb);
        await policyRepo.update(request.entity_id, { status: 'under_review' });
      } catch (e) {
        logError('Failed to update policy status on resubmit', { error: e });
      }
    } else if (request.entity_type === 'risk') {
      // For risks: bump version to capture change and keep history
      try {
        const { RiskRepository } = await import('../repositories/riskRepository.js');
        const { incrementVersion } = await import('../repositories/policyRepository.js');
        const riskRepo = new RiskRepository(tenantDb);
        const risk = await riskRepo.findById(request.entity_id);
        if (risk) {
          const currentVersion = risk.version || 'v1.0';
          const newVersion = incrementVersion(currentVersion);
          await riskRepo.update(request.entity_id, { version: newVersion });
          logInfo('Risk version incremented on resubmit', {
            riskId: request.entity_id,
            from: currentVersion,
            to: newVersion
          });
        }
      } catch (e) {
        logError('Failed to update risk version on resubmit', { error: e });
      }
    }

    logInfo('Approval request resubmitted', { approvalRequestId, submitterUserId });

    return await approvalRequestRepo.findById(approvalRequestId);
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

  /**
   * Create approval request for a project delivery extra-expense change
   * (workflow category: project_delivery_changes, request_type: project_delivery_changes)
   */
  async createProjectDeliveryChangesApprovalRequest(projectId, overBudgetAmount, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const Project = tenantDb.model('ProjectRegister');
    const project = await Project.findById(projectId);
    if (!project) {
      throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }

    // Use the over-budget amount for threshold matching against project_delivery_changes rules
    const amount = Number(overBudgetAmount || 0);
    const { matrix, rule } = await this.findMatchingRule('project_delivery_changes', amount, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);

    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'project_delivery_changes',
      entity_id: projectId,
      entity_type: 'project',
      amount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    return approvalRequest;
  }

  /**
   * Create approval request for a project refund sign-off (uses project_delivery_changes workflow rules)
   * (workflow category: project_delivery_changes, request_type: project_delivery_changes)
   *
   * We keep entity_type as 'project' (schema constraint) and later correlate by
   * ProjectRefund.internal_approval_request_id.
   */
  async createProjectRefundApprovalRequest(projectId, refundAmount, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const Project = tenantDb.model('ProjectRegister');
    const project = await Project.findById(projectId);
    if (!project) {
      throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }

    const amount = Number(refundAmount || 0);
    const { matrix, rule } = await this.findMatchingRule('project_delivery_changes', amount, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);

    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'project_delivery_changes',
      entity_id: projectId,
      entity_type: 'project',
      amount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    return approvalRequest;
  }

  /**
   * Create approval request for project delivery completion / handoff
   * (workflow category: project_delivery, request_type: project_delivery)
   *
   * Note: amount is 0 because this workflow is compliance-driven (not monetary).
   * Configure approval matrix rules with action_type "project_delivery".
   */
  async createProjectDeliveryCompletionRequest(projectId, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const Project = tenantDb.model('ProjectRegister');
    const project = await Project.findById(projectId);
    if (!project) {
      throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }

    const { matrix, rule } = await this.findMatchingRule('project_delivery', 0, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);

    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id || undefined,
      approver_position_id: approver.position_id,
      approver_department_id: approver.department_id,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'project_delivery',
      entity_id: projectId,
      entity_type: 'project',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    return approvalRequest;
  }

  /**
   * Create approval workflow for an uploaded fiscal report (action_type: financial_reporting).
   * Called from documentController.createDocument right after a fiscal_report file is saved.
   * Stamps the resulting approval_request_id back onto document.metadata so the FE cell can
   * deep-link to the workflow.
   */
  async createFinancialReportingApprovalRequest(documentId, submittedBy) {
    return this._createDocumentDrivenApprovalRequest({
      documentId,
      submittedBy,
      actionType: 'financial_reporting',
      requestType: 'financial_reporting',
      categoryLabel: 'Financial Reporting'
    });
  }

  /**
   * Create approval workflow for an uploaded BAS lodgement (action_type: bas_lodgement).
   * Mirrors createFinancialReportingApprovalRequest — same shape, different category.
   */
  async createBasLodgementApprovalRequest(documentId, submittedBy) {
    return this._createDocumentDrivenApprovalRequest({
      documentId,
      submittedBy,
      actionType: 'bas_lodgement',
      requestType: 'bas_lodgement',
      categoryLabel: 'BAS Lodgment'
    });
  }

  /**
   * Shared implementation for upload-driven workflows where the entity is a Document
   * and the workflow is non-tiered (single rule per category, amount = 0).
   * @private
   */
  async _createDocumentDrivenApprovalRequest({ documentId, submittedBy, actionType, requestType, categoryLabel }) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const documentRepo = new DocumentRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const document = await documentRepo.findById(documentId);
    if (!document) {
      throw new AppError(`${categoryLabel} document not found`, 404, 'DOCUMENT_NOT_FOUND');
    }

    // Resolves the workflow for this action_type. If none configured this throws
    // WORKFLOW_NOT_CONFIGURED with structured details — caller (documentController)
    // should surface it rather than silently swallow, so the user knows the upload
    // landed but the workflow couldn't start.
    const { matrix, rule } = await this.findMatchingRule(actionType, 0, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);

    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id || undefined,
      approver_position_id: approver.position_id || undefined,
      approver_department_id: approver.department_id || undefined,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: requestType,
      entity_id: document._id,
      entity_type: 'document',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy
    });

    // Stamp the approval_request_id back onto the document so the FE cell can link to it.
    // Preserve any existing metadata fields (period_year, period_month, etc).
    const nextMetadata = { ...(document.metadata || {}), approval_request_id: approvalRequest._id };
    await documentRepo.update(document._id, {
      metadata: nextMetadata,
      status: 'review_pending'
    });

    // Email notifications to approvers (same pattern as expense workflow).
    try {
      const userRepo = new UserRepository(tenantDb);
      const submitter = await userRepo.findById(submittedBy);
      const submitterName = submitter ? `${submitter.first_name || ''} ${submitter.last_name || ''}`.trim() || 'A user' : 'A user';

      for (const approver of approvers) {
        if (!approver.user_id) continue;
        const approverUser = await userRepo.findById(approver.user_id);
        if (!approverUser?.email) continue;
        const approverName = `${approverUser.first_name || ''} ${approverUser.last_name || ''}`.trim();
        await emailService.sendApprovalRequestEmail({
          to: approverUser.email,
          recipientName: approverName,
          approvalRequestId: approvalRequest._id.toString(),
          requestType,
          entityTitle: document.title || categoryLabel,
          approvalLevel: approver.level,
          submitterName,
          approvalType: rule.approval_type
        });
      }
    } catch (emailError) {
      logError('Failed to send approval request emails', { error: emailError.message, approvalRequestId: approvalRequest._id });
      // Non-fatal — workflow created OK, email is best-effort.
    }

    logInfo('Document-driven approval workflow created', {
      requestType, documentId: String(document._id), approvalRequestId: String(approvalRequest._id)
    });

    return approvalRequest;
  }

  async createSweepFundsApprovalRequest(payload, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const amount = Number(payload?.amount || 0);
    if (!(amount > 0)) {
      throw new AppError('Sweep amount must be greater than 0', 400, 'INVALID_SWEEP_AMOUNT');
    }

    const { matrix, rule } = await this.findMatchingRule('sweep_funds', amount, orgObjectId);
    const approvers = await this.resolveApprovers(rule, orgObjectId);
    const approvalSteps = approvers.map((approver) => ({
      level: approver.level,
      approver_user_id: approver.user_id || undefined,
      approver_position_id: approver.position_id || undefined,
      approver_department_id: approver.department_id || undefined,
      status: 'pending'
    }));

    const approvalRequest = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'sweep_funds',
      entity_id: new mongoose.Types.ObjectId(),
      entity_type: 'other',
      amount,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type,
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy,
      sweep_funds: {
        source_portal: payload.source_portal,
        source_account_identifier: payload.source_account_identifier || '',
        destination_asset_id: payload.destination_asset_id,
        destination_account_label: payload.destination_account_label || '',
        receipt_files: Array.isArray(payload.receipt_files) ? payload.receipt_files : [],
        audit_trail: [{
          action: 'initiated',
          by_user_id: submittedBy,
          comments: payload.comments || '',
          created_at: new Date()
        }]
      }
    });

    return approvalRequest;
  }

  /**
   * Create approval workflow for complaint resolution
   * Called when admin approves a complaint - initiates the complaint_resolution workflow
   * This workflow has three steps:
   * 1. Root cause & resolution details
   * 2. Link/create risk
   * 3. Link/create training
   * After step 3: if major, board signoff is required; otherwise complaint is resolved
   */
  async createComplaintResolutionWorkflow(complaintId, submittedBy, metadata = {}) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgObjectId = await this._getOrgObjectId();
    const { ComplaintRepository } = await import('../repositories/complaintRepository.js');
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const complaintRepo = new ComplaintRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);

    const complaint = await complaintRepo.findById(complaintId);
    if (!complaint) {
      throw new AppError('Complaint not found', 404, 'COMPLAINT_NOT_FOUND');
    }

    // Use configured approval matrix for complaint workflows (Roles & Permissions → Approval Workflows)
    const { matrix, rule } = await this.findMatchingRule('complaint', 0, orgObjectId);
    if (matrix?.workflow_category && matrix.workflow_category !== 'complaint_resolution') {
      throw new AppError(
        'Complaint workflow is misconfigured. Expected workflow category "complaint_resolution".',
        400,
        'COMPLAINT_WORKFLOW_MISCONFIGURED'
      );
    }

    const approvers = await this.resolveApprovers(rule, orgObjectId);
    const approverUserIds = approvers.map(a => String(a.user_id)).filter(Boolean);

    if (approverUserIds.length === 0) {
      throw new AppError(
        'No approvers resolved for complaint workflow. Please configure positions/users for the workflow steps.',
        400,
        'NO_APPROVERS_FOUND'
      );
    }

    // If major and the organization actually has board members configured,
    // enforce that the selected board member is the final approver.
    // If there are no active board members, fall back to the normal workflow
    // approvers only (last workflow approver will effectively be the final signer).
    const finalApprovers = [...approverUserIds];
    if (metadata?.is_major) {
      const activeBoardCount = await boardMemberRepo.countByOrgId(orgObjectId);
      if (activeBoardCount > 0) {
        const boardUserId = complaint.board_signoff_user_id
          ? String(complaint.board_signoff_user_id)
          : '';
        if (!boardUserId) {
          throw new AppError(
            'Select a board member for sign-off before proceeding.',
            400,
            'MISSING_BOARD_SIGNOFF'
          );
        }

        // Ensure board member is last (remove if already included earlier)
        const withoutBoard = finalApprovers.filter((id) => String(id) !== boardUserId);
        finalApprovers.length = 0;
        finalApprovers.push(...withoutBoard, boardUserId);
      }
      // When there are no board members, we intentionally do NOT throw;
      // the resolution workflow will be completed by the last workflow approver.
    }

    const approvalSteps = finalApprovers.map((userId, index) => ({
      level: index + 1,
      approver_user_id: userId,
      status: 'pending',
    }));

    // Create workflow instance
    const workflowInstance = await approvalRequestRepo.create({
      org_id: orgObjectId,
      request_type: 'complaint_resolution',
      entity_id: complaintId,
      entity_type: 'complaint',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type || 'sequential',
      status: 'pending',
      approval_steps: approvalSteps,
      submitted_by: submittedBy,
      workflow_type: 'complaint_resolution',
      metadata: {
        is_major: metadata?.is_major || false,
        complaint_title: complaint.complaint_title,
        department_id: complaint.category,
      }
    });

    logInfo('Complaint resolution workflow created', {
      complaintId,
      workflowInstanceId: workflowInstance._id,
      is_major: metadata?.is_major,
      approversCount: approvalSteps.length,
      approvalMatrixId: matrix?._id
    });

    return workflowInstance;
  }}