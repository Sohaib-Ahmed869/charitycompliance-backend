/**
 * Risk Service
 *
 * Business logic for risk management and approval workflow trigger
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { DepartmentRepository } from '../repositories/departmentRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { ChecklistService } from './checklistService.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo } from '../utils/logger.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { decryptBoardMemberFields } from '../utils/decryptBoardMember.js';

function getInherentLevel(score) {
  if (score <= 4) return 'low';
  if (score <= 9) return 'moderate';
  if (score <= 14) return 'high';
  if (score <= 19) return 'extreme';
  return 'critical';
}

export class RiskService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /** Resolve tenant slug to Organization ObjectId (for org_id in risk schema). */
  async _getOrgObjectId() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    return org._id;
  }

  /** Ensure User (and other refs) are registered on tenant connection so Risk populate() works. */
  _ensureTenantModels(tenantDb) {
    void new UserRepository(tenantDb);
    void new BoardMemberRepository(tenantDb);
  }

  async createRisk(riskData, submittedBy) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgId = await this._getOrgObjectId();

    const riskRepo = new RiskRepository(tenantDb);
    let risk_owner_id = riskData.risk_owner_id;
    let risk_owner_board_member_id = riskData.risk_owner_board_member_id || null;
    const department_id = riskData.department_id || null;
    let departmentName = riskData.department || null;

    // Resolve department name from department_id if not provided
    if (department_id && !departmentName) {
      const departmentRepo = new DepartmentRepository(tenantDb);
      const dept = await departmentRepo.findById(department_id);
      if (dept) departmentName = dept.name;
    }

    // Legacy: if risk_owner_board_member_id provided, resolve user_id
    if (risk_owner_board_member_id) {
      const boardMemberRepo = new BoardMemberRepository(tenantDb);
      const boardMember = await boardMemberRepo.findById(risk_owner_board_member_id);
      if (boardMember?.user_id) risk_owner_id = boardMember.user_id;
    }
    // If no specific owner selected, default to the submitting user
    if (!risk_owner_id && !risk_owner_board_member_id) {
      risk_owner_id = submittedBy;
    }

    // Severity is intentionally NOT defaulted at create time. The department
    // head sets likelihood + severity during the first-step approval, and only
    // then is the risk's priority (low / moderate / high) computed.
    const likelihood = Number.isFinite(riskData.likelihood) && riskData.likelihood > 0
      ? riskData.likelihood
      : null;
    const consequence = Number.isFinite(riskData.consequence) && riskData.consequence > 0
      ? riskData.consequence
      : null;
    const inherent_risk_score = likelihood != null && consequence != null ? likelihood * consequence : null;
    const inherent_risk_level = inherent_risk_score != null ? getInherentLevel(inherent_risk_score) : null;

    const risk = await riskRepo.create({
      org_id: orgId,
      title: riskData.title,
      description: riskData.description || '',
      category: riskData.category,
      department: departmentName,
      department_id,
      risk_owner_id,
      risk_owner_board_member_id,
      next_review_date: riskData.next_review_date,
      ...(likelihood != null ? { likelihood } : {}),
      ...(consequence != null ? { consequence } : {}),
      ...(inherent_risk_score != null ? { inherent_risk_score } : {}),
      ...(inherent_risk_level != null ? { inherent_risk_level } : {}),
      existing_controls: riskData.existing_controls || '',
      trend: riskData.trend || 'stable',
      status: 'draft',
      submitted_by: submittedBy,
      metadata: { ...(riskData.metadata || {}), awaiting_hod_assessment: true }
    });

    logInfo('Risk created', { riskId: risk._id, submittedBy });

    let approvalRequestId = null;
    try {
      // Two-phase risk approval: a single-step request asking the department
      // head to assess severity. The severity-matched workflow is attached
      // AFTER the HoD approves (see approveRiskWithPriority in approvalController).
      const workflowService = new ApprovalWorkflowService(this.orgId);
      const workflowReq = await workflowService.createRiskHodAssessmentRequest(risk._id, submittedBy);
      approvalRequestId = workflowReq?._id || workflowReq?.id || null;
    } catch (err) {
      // Expected "no setup" cases → auto-approve the risk so creation still works.
      const errCode = err?.code;
      const isNoSetup =
        err?.name === 'CastError' ||
        errCode === 'INVALID_ID' ||
        errCode === 'NO_APPROVAL_MATRIX' ||
        errCode === 'NO_MATCHING_RULE' ||
        errCode === 'RISK_NO_DEPARTMENT' ||
        errCode === 'NO_DEPARTMENT_HEAD';

      if (!isNoSetup) {
        await riskRepo.delete(risk._id);
        throw err;
      }

      logInfo('Risk auto-approved (no HoD / no matrix configured)', {
        riskId: risk._id,
        submittedBy,
        errCode: errCode || err?.name
      });

      await riskRepo.update(risk._id, {
        status: 'approved',
        approval_matrix_id: null,
        approval_request_id: null
      });
    }

    // Ensure risk workflow checklist is created even when approvals are auto-approved.
    try {
      const checklistService = new ChecklistService(this.orgId);
      await checklistService.ensureWorkflowChecklistForApproval({
        entityType: 'risk',
        entityId: String(risk._id),
        approvalRequestId: approvalRequestId ? String(approvalRequestId) : null,
        createdBy: submittedBy
      });
    } catch (checklistErr) {
      logInfo('Risk created but checklist could not be initialized', {
        riskId: risk._id,
        error: checklistErr?.message
      });
    }

    const created = await riskRepo.findById(risk._id);
    return this._decryptRiskOwnerBoardMember(created);
  }

  _decryptRiskOwnerBoardMember(risk) {
    const keyHex = getMasterKeyHex();
    if (!keyHex) return risk;
    const plain = risk?.toObject ? risk.toObject() : (risk ? { ...risk } : risk);
    if (plain?.risk_owner_board_member_id && typeof plain.risk_owner_board_member_id === 'object') {
      decryptBoardMemberFields(plain.risk_owner_board_member_id, keyHex);
    }
    return plain;
  }

  /**
   * Resubmit a rejected (or returned-for-resubmission) risk. Resets
   * the status to `pending`, optionally accepts any field updates,
   * then re-triggers the HoD assessment approval request — mirroring
   * the createRisk path so the same review chain runs from scratch.
   */
  async resubmitRisk(riskId, submittedBy, updates = {}) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const riskRepo = new RiskRepository(tenantDb);

    const existing = await riskRepo.findById(riskId);
    if (!existing) throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');

    const resubmittableStatuses = ['rejected', 'resubmission_required', 'draft'];
    if (!resubmittableStatuses.includes(existing.status)) {
      throw new AppError(
        `Risk cannot be resubmitted from status "${existing.status}". Only rejected, resubmission_required, or draft risks can be resubmitted.`,
        400,
        'RISK_NOT_RESUBMITTABLE'
      );
    }

    // Apply any field updates first, then clear the approval state and
    // mark pending so the workflow trigger below picks up the latest data.
    const merged = {
      ...(updates && typeof updates === 'object' ? updates : {}),
      status: 'pending',
      approval_request_id: null,
      approval_matrix_id: null,
      rejection_reason: null,
      resubmitted_at: new Date()
    };
    await riskRepo.update(riskId, merged);

    let approvalRequestId = null;
    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      const workflowReq = await workflowService.createRiskHodAssessmentRequest(riskId, submittedBy);
      approvalRequestId = workflowReq?._id || workflowReq?.id || null;
    } catch (err) {
      const errCode = err?.code;
      const isNoSetup =
        err?.name === 'CastError' ||
        errCode === 'INVALID_ID' ||
        errCode === 'NO_APPROVAL_MATRIX' ||
        errCode === 'NO_MATCHING_RULE' ||
        errCode === 'RISK_NO_DEPARTMENT' ||
        errCode === 'NO_DEPARTMENT_HEAD';
      if (!isNoSetup) throw err;
      // Auto-approve fallback — same behaviour as createRisk so the
      // resubmit flow doesn't dead-end when no HoD / matrix exists.
      await riskRepo.update(riskId, {
        status: 'approved',
        approval_matrix_id: null,
        approval_request_id: null
      });
    }

    logInfo('Risk resubmitted', { riskId, submittedBy, approvalRequestId });
    const fresh = await riskRepo.findById(riskId);
    return this._decryptRiskOwnerBoardMember(fresh);
  }

  async getRisks(filters = {}) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgId = await this._getOrgObjectId();
    const riskRepo = new RiskRepository(tenantDb);
    const risks = await riskRepo.findByOrgId(orgId, filters);
    const keyHex = getMasterKeyHex();
    if (!keyHex) return risks;
    return risks.map((r) => this._decryptRiskOwnerBoardMember(r));
  }

  async getRiskById(riskId) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const riskRepo = new RiskRepository(tenantDb);
    const risk = await riskRepo.findById(riskId);
    if (!risk) {
      throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
    }
    return this._decryptRiskOwnerBoardMember(risk);
  }

  async getRiskCounts() {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const orgId = await this._getOrgObjectId();
    const riskRepo = new RiskRepository(tenantDb);
    return await riskRepo.getCountsByOrg(orgId);
  }

  async updateRisk(riskId, updateData) {
    const tenantDb = await this.getTenantDb();
    this._ensureTenantModels(tenantDb);
    const riskRepo = new RiskRepository(tenantDb);
    const risk = await riskRepo.findById(riskId);
    if (!risk) {
      throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
    }
    if (updateData.likelihood !== undefined || updateData.consequence !== undefined) {
      const likelihood = updateData.likelihood ?? risk.likelihood;
      const consequence = updateData.consequence ?? risk.consequence;
      updateData.inherent_risk_score = likelihood * consequence;
      updateData.inherent_risk_level = getInherentLevel(updateData.inherent_risk_score);
    }
    if (updateData.risk_owner_board_member_id != null) {
      const boardMemberRepo = new BoardMemberRepository(tenantDb);
      const boardMember = await boardMemberRepo.findById(updateData.risk_owner_board_member_id);
      updateData.risk_owner_id = boardMember?.user_id || null;
    }
    if (updateData.department_id != null) {
      const departmentRepo = new DepartmentRepository(tenantDb);
      const dept = await departmentRepo.findById(updateData.department_id);
      if (dept) updateData.department = dept.name;
    }
    await riskRepo.update(riskId, updateData);
    const updated = await riskRepo.findById(riskId);
    return this._decryptRiskOwnerBoardMember(updated);
  }

  async deleteRisk(riskId) {
    const tenantDb = await this.getTenantDb();
    const riskRepo = new RiskRepository(tenantDb);
    const risk = await riskRepo.findById(riskId);
    if (!risk) {
      throw new AppError('Risk not found', 404, 'RISK_NOT_FOUND');
    }
    await riskRepo.delete(riskId);
    return { deleted: true };
  }
}
