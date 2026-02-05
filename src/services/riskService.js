/**
 * Risk Service
 *
 * Business logic for risk management and approval workflow trigger
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
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
    const risk_owner_board_member_id = riskData.risk_owner_board_member_id || null;
    if (risk_owner_board_member_id) {
      const boardMemberRepo = new BoardMemberRepository(tenantDb);
      const boardMember = await boardMemberRepo.findById(risk_owner_board_member_id);
      if (boardMember?.user_id) risk_owner_id = boardMember.user_id;
    }
    // If no specific owner selected, default to the submitting user
    if (!risk_owner_id && !risk_owner_board_member_id) {
      risk_owner_id = submittedBy;
    }

    const likelihood = riskData.likelihood ?? 1;
    const consequence = riskData.consequence ?? 1;
    const inherent_risk_score = likelihood * consequence;
    const inherent_risk_level = getInherentLevel(inherent_risk_score);

    const risk = await riskRepo.create({
      org_id: orgId,
      title: riskData.title,
      description: riskData.description || '',
      category: riskData.category,
      department: riskData.department,
      risk_owner_id,
      risk_owner_board_member_id,
      next_review_date: riskData.next_review_date,
      likelihood,
      consequence,
      inherent_risk_score,
      inherent_risk_level,
      existing_controls: riskData.existing_controls || '',
      trend: riskData.trend || 'stable',
      status: 'draft',
      submitted_by: submittedBy,
      metadata: riskData.metadata || {}
    });

    logInfo('Risk created', { riskId: risk._id, submittedBy });

    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      await workflowService.createRiskApprovalRequest(risk._id, submittedBy);
    } catch (err) {
      // If there's no approval workflow for risk management, auto-approve the risk.
      // This keeps risk creation working even when approval matrices are not configured.
      const errCode = err?.code;
      const isNoWorkflow =
        err?.name === 'CastError' ||
        errCode === 'INVALID_ID' ||
        errCode === 'NO_APPROVAL_MATRIX' ||
        errCode === 'NO_MATCHING_RULE';
        // IMPORTANT: we intentionally do NOT treat NO_APPROVERS_FOUND as "no workflow".
        // If a risk workflow is configured (action_type: "risk") but no approvers can
        // be resolved, the request should fail so the user fixes their setup.

      if (!isNoWorkflow) {
        await riskRepo.delete(risk._id);
        throw err;
      }

      logInfo('No approval workflow for risk_management; auto-approving risk', {
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
