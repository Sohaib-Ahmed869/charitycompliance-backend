/**
 * COI Workflow Service
 * 
 * Handles approval processing for COI requests and resume/reject behavior.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { PolicyRepository } from '../repositories/policyRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo } from '../utils/logger.js';

export class CoiWorkflowService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /** Resolve tenant slug to Organization ObjectId. */
  async _getOrgObjectId() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    return org._id;
  }

  async _getUserPositionIds(userId) {
    const tenantDb = await this.getTenantDb();
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const userPositions = await userPositionRepo.findByUserId(userId, true);
    const positionIds = new Set();

    userPositions.forEach((up) => {
      // position_id is populated and can be an object with _id, or just the ID
      if (up.position_id?._id) {
        positionIds.add(String(up.position_id._id));
        return;
      }
      if (up.position_id) {
        positionIds.add(String(up.position_id));
      }
    });

    const orgObjectId = await this._getOrgObjectId();
    const boardMember = await boardMemberRepo.findByUserId(userId, orgObjectId);
    if (boardMember?.position_id?._id) {
      positionIds.add(String(boardMember.position_id._id));
    } else if (boardMember?.position_id) {
      positionIds.add(String(boardMember.position_id));
    }

    return Array.from(positionIds);
  }

  _canUserApproveStep(step, userId, userPositionIds) {
    if (!step) return false;
    const stepUserId = step.approver_user_id?._id || step.approver_user_id;
    if (stepUserId && String(userId) === stepUserId) return true;
    if (step.approver_position_id && userPositionIds?.length > 0) {
      const stepPosId = step.approver_position_id?._id || step.approver_position_id;
      return userPositionIds.some((id) => String(id) === String(stepPosId));
    }
    return false;
  }

  /**
   * Resolve approvers from approval matrix rule
   * Converts position/department/user references to actual user IDs
   * @param {Object} approvalRule - The approval rule (can be a matrix or a rule)
   */
  async resolveApprovers(approvalRule, orgId) {
    const tenantDb = await this.getTenantDb();
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const approvers = [];

    // Handle both formats: matrix with rules array OR direct rule
    let rule = approvalRule;
    if (approvalRule.approval_rules && Array.isArray(approvalRule.approval_rules)) {
      rule = approvalRule.approval_rules[0];
    }
    
    if (!rule || !rule.requires_approval_from) {
      throw new AppError('No approval rule configuration found', 400, 'NO_APPROVAL_RULES');
    }

    for (const approverConfig of rule.requires_approval_from) {
      let userIds = [];

      if (approverConfig.user_id) {
        // Specific user
        userIds = [approverConfig.user_id];
      } else if (approverConfig.position_id) {
        // Find all users in this position
        userIds = await userPositionRepo.findUsersByPositionId(approverConfig.position_id);
        if (userIds.length === 0) {
          logInfo('No users found for position in COI workflow', { positionId: approverConfig.position_id });
          // Don't throw error, just skip this approver config
          continue;
        }
      } else if (approverConfig.department_id) {
        // Find all users in this department
        userIds = await userPositionRepo.findUsersByDepartmentId(approverConfig.department_id);
        if (userIds.length === 0) {
          logInfo('No users found for department in COI workflow', { departmentId: approverConfig.department_id });
          // Don't throw error, just skip this approver config
          continue;
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

    if (approvers.length === 0) {
      throw new AppError('No approvers could be resolved for COI workflow', 400, 'NO_APPROVERS_FOUND');
    }

    // Sort by level
    approvers.sort((a, b) => a.level - b.level);

    return approvers;
  }

  async getPendingCoiForUser(userId) {
    const tenantDb = await this.getTenantDb();
    const coiRepo = new CoiRequestRepository(tenantDb);
    const userPositionIds = await this._getUserPositionIds(userId);
    const requests = await coiRepo.findPendingByApprover(userId, userPositionIds);

    logInfo('COI pending lookup', {
      userId: String(userId),
      positionIds: userPositionIds.map((id) => String(id)),
      pendingCount: requests.length
    });

    return requests.map((request) => {
      const userSteps = request.approval_steps.filter(step =>
        this._canUserApproveStep(step, userId, userPositionIds)
      );

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
  }

  async processCoiApproval(coiRequestId, stepIndex, userId, decision, comments = null, ipAddress = null, userAgent = null) {
    const tenantDb = await this.getTenantDb();
    const coiRepo = new CoiRequestRepository(tenantDb);
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const expenseRepo = new ExpenseRepository(tenantDb);
    const riskRepo = new RiskRepository(tenantDb);
    const policyRepo = new PolicyRepository(tenantDb);

    const request = await coiRepo.findById(coiRequestId);
    logInfo('Processing COI approval step', {
      coiRequestId,
      currentStatus: request?.status,
      stepIndex,
      decision
    });

    if (!request) {
      throw new AppError('COI request not found', 404, 'COI_REQUEST_NOT_FOUND');
    }

    if (request.status !== 'pending') {
      throw new AppError(`COI request is already ${request.status}`, 400, 'COI_REQUEST_NOT_PENDING');
    }

    const step = request.approval_steps[stepIndex];
    if (!step) {
      throw new AppError('COI approval step not found', 404, 'COI_STEP_NOT_FOUND');
    }

    if (step.status !== 'pending') {
      throw new AppError(`This COI step is already ${step.status}`, 400, 'COI_STEP_ALREADY_PROCESSED');
    }

    const userPositionIds = await this._getUserPositionIds(userId);
    const canApprove = this._canUserApproveStep(step, userId, userPositionIds);
    if (!canApprove) {
      throw new AppError('You are not authorized to approve this COI step', 403, 'UNAUTHORIZED');
    }

    if (request.approval_type === 'sequential') {
      for (let i = 0; i < stepIndex; i++) {
        if (request.approval_steps[i].status !== 'approved') {
          throw new AppError('Previous COI steps must be completed first', 400, 'PREVIOUS_STEPS_PENDING');
        }
      }
    }

    const updateData = {
      status: decision,
      comments: comments || null
    };

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

    await coiRepo.updateApprovalStep(coiRequestId, stepIndex, updateData);

    const updatedRequest = await coiRepo.findById(coiRequestId);
    const allSteps = updatedRequest.approval_steps;

    if (decision === 'rejected') {
      await coiRepo.updateStatus(coiRequestId, 'rejected');

      // Reject the parent approval request when COI is rejected
      const parent = await approvalRequestRepo.findById(updatedRequest.parent_approval_request_id);
      if (parent) {
        await approvalRequestRepo.updateStatus(parent._id, 'rejected', {
          cancelled_at: new Date(),
          cancellation_reason: 'COI rejected',
          paused_step_index: null,
          paused_at: null,
          current_coi_request_id: null
        });

        if (parent.entity_type === 'expense') {
          await expenseRepo.updateStatus(parent.entity_id, 'rejected', {
            rejection_reason: 'COI rejected',
            rejected_by: userId,
            rejected_at: new Date()
          });
        } else if (parent.entity_type === 'risk') {
          await riskRepo.updateStatus(parent.entity_id, 'rejected');
        } else if (parent.entity_type === 'policy') {
          await policyRepo.update(parent.entity_id, { status: 'draft' });
        }
      }

      return updatedRequest;
    }

    let allApproved = false;

    if (updatedRequest.approval_type === 'any') {
      allApproved = allSteps.some(s => s.status === 'approved');
    } else if (updatedRequest.approval_type === 'parallel') {
      allApproved = allSteps.every(s => s.status === 'approved');
    } else if (updatedRequest.approval_type === 'sequential') {
      allApproved = allSteps.every(s => s.status === 'approved');
    }

    if (allApproved) {
      await coiRepo.updateStatus(coiRequestId, 'approved');

      // Resume main approval request
      await approvalRequestRepo.update(updatedRequest.parent_approval_request_id, {
        status: 'pending',
        paused_step_index: null,
        paused_at: null,
        current_coi_request_id: null
      });
    }

    return updatedRequest;
  }
}
