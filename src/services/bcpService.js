/**
 * BCP Service
 * 
 * Business logic for Business Continuity Plan operations
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { 
  BcpEmergencyTeamRepository,
  BcpRiskRepository,
  BcpCredentialVaultRepository,
  BcpEmergencyActivationRepository,
  BcpAuthorityTransferRepository
} from '../repositories/bcpRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { PositionRepository } from '../repositories/positionRepository.js';
import { UserPositionRepository } from '../repositories/userPositionRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';
import emailService from './emailService.js';
import mongoose from 'mongoose';
import crypto from 'crypto';

// Simple encryption for vault (should use proper key management in production)
const VAULT_SECRET = process.env.VAULT_ENCRYPTION_KEY || 'bcp-vault-secret-key-32chars!!';

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(VAULT_SECRET.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
  if (!encrypted) return '';
  const parts = encrypted.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const cipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(VAULT_SECRET.padEnd(32).slice(0, 32)), iv);
  let decrypted = cipher.update(parts[1], 'hex', 'utf8');
  decrypted += cipher.final('utf8');
  return decrypted;
}

export class BcpService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  // ==================== EMERGENCY TEAM ====================

  async createEmergencyTeam(teamData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyTeamRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }

    const team = await repo.create({
      ...teamData,
      org_id: org._id,
      created_by: userId
    });

    logInfo('BCP Emergency Team created', { orgId: this.orgId, teamId: team._id });
    return team;
  }

  async getEmergencyTeams(status = 'active') {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyTeamRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findByOrgId(org._id, status);
  }

  async getEmergencyTeamById(teamId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyTeamRepository(tenantDb);
    return await repo.findById(teamId);
  }

  async updateEmergencyTeam(teamId, updateData) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyTeamRepository(tenantDb);
    return await repo.update(teamId, updateData);
  }

  async deleteEmergencyTeam(teamId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyTeamRepository(tenantDb);
    return await repo.delete(teamId);
  }

  // ==================== BCP RISKS ====================

  async createRisk(riskData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }

    // Calculate next review date based on frequency
    const reviewDays = {
      monthly: 30,
      quarterly: 90,
      semi_annually: 180,
      annually: 365
    };
    
    const nextReviewDate = new Date();
    nextReviewDate.setDate(nextReviewDate.getDate() + (reviewDays[riskData.review_frequency] || 90));

    const risk = await repo.create({
      ...riskData,
      org_id: org._id,
      created_by: userId,
      next_review_date: nextReviewDate
    });

    logInfo('BCP Risk created', { orgId: this.orgId, riskId: risk._id, category: risk.category });
    return risk;
  }

  async getRisks(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findByOrgId(org._id, filters);
  }

  async getRiskById(riskId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    return await repo.findById(riskId);
  }

  async updateRisk(riskId, updateData) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    return await repo.update(riskId, updateData);
  }

  async escalateRisk(riskId, escalationData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);
    
    const escalation = {
      ...escalationData,
      escalated_by: userId,
      escalated_at: new Date()
    };

    const risk = await repo.addEscalation(riskId, escalation);

    // Send notification to escalation target
    if (escalationData.escalated_to === 'trustee') {
      // Notify all trustees
      logInfo('BCP Risk escalated to trustees', { orgId: this.orgId, riskId });
    }

    return risk;
  }

  async getRiskStats() {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.getStats(org._id);
  }

  async getRisksDueForReview() {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpRiskRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findDueForReview(org._id);
  }

  // ==================== CREDENTIAL VAULT ====================

  async createCredential(credentialData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }

    // Encrypt sensitive data
    const encryptedCredentials = {
      username_encrypted: credentialData.credentials?.username ? encrypt(credentialData.credentials.username) : '',
      password_encrypted: credentialData.credentials?.password ? encrypt(credentialData.credentials.password) : '',
      url: credentialData.credentials?.url || '',
      additional_info_encrypted: credentialData.credentials?.additional_info ? encrypt(credentialData.credentials.additional_info) : ''
    };

    const credential = await repo.create({
      ...credentialData,
      credentials: encryptedCredentials,
      org_id: org._id,
      created_by: userId,
      last_password_change: new Date()
    });

    logInfo('BCP Credential stored', { orgId: this.orgId, credentialId: credential._id, category: credential.category });
    return credential;
  }

  async getCredentials(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    // Returns credentials without password/sensitive info
    return await repo.findByOrgId(org._id, filters);
  }

  async getCredentialById(credentialId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    const credential = await repo.findById(credentialId);
    
    // Don't return encrypted sensitive data
    if (credential) {
      credential.credentials = {
        url: credential.credentials?.url,
        has_username: !!credential.credentials?.username_encrypted,
        has_password: !!credential.credentials?.password_encrypted
      };
    }
    
    return credential;
  }

  async requestCredentialAccess(credentialId, requestData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    
    const request = {
      requested_by: userId,
      reason: requestData.reason,
      required_approvals: 2,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    };

    const credential = await repo.addAccessRequest(credentialId, request);
    
    // TODO: Notify trustees about access request
    logInfo('BCP Credential access requested', { orgId: this.orgId, credentialId, requestedBy: userId });
    
    return credential;
  }

  async approveCredentialAccess(credentialId, requestId, trusteeId, approved, comments) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    
    const credential = await repo.approveAccessRequest(credentialId, requestId, trusteeId, approved, comments);
    
    logInfo('BCP Credential access approval', { 
      orgId: this.orgId, 
      credentialId, 
      requestId, 
      approved,
      approvedBy: trusteeId 
    });
    
    return credential;
  }

  async accessCredential(credentialId, requestId, userId, ipAddress, userAgent) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    
    // Verify access is approved
    const credential = await repo.findById(credentialId);
    const request = credential.access_requests?.find(r => r._id.toString() === requestId && r.status === 'approved');
    
    if (!request) {
      throw new AppError('Access not approved', 403, 'ACCESS_DENIED');
    }

    // Log access
    await repo.logAccess(credentialId, {
      accessed_by: userId,
      access_type: 'view',
      access_request_id: requestId,
      ip_address: ipAddress,
      user_agent: userAgent
    });

    // Decrypt and return credentials
    const decryptedCredentials = {
      username: credential.credentials?.username_encrypted ? decrypt(credential.credentials.username_encrypted) : '',
      password: credential.credentials?.password_encrypted ? decrypt(credential.credentials.password_encrypted) : '',
      url: credential.credentials?.url || '',
      additional_info: credential.credentials?.additional_info_encrypted ? decrypt(credential.credentials.additional_info_encrypted) : ''
    };

    logInfo('BCP Credential accessed', { orgId: this.orgId, credentialId, accessedBy: userId });

    return decryptedCredentials;
  }

  async getExpiringCredentials(daysAhead = 30) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpCredentialVaultRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findExpiringCredentials(org._id, daysAhead);
  }

  // ==================== EMERGENCY ACTIVATION ====================

  async triggerEmergency(emergencyData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    const teamRepo = new BcpEmergencyTeamRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }

    // Get active emergency team
    const teams = await teamRepo.findByOrgId(org._id, 'active');
    if (teams.length === 0) {
      throw new AppError('No active emergency response team configured', 400, 'NO_TEAM');
    }

    const emergency = await repo.create({
      ...emergencyData,
      org_id: org._id,
      triggered_by: userId,
      emergency_team_id: emergencyData.emergency_team_id || teams[0]._id,
      status: 'triggered'
    });

    // Notify team members
    const team = teams.find(t => t._id.toString() === (emergencyData.emergency_team_id || teams[0]._id).toString());
    if (team) {
      // Get users in team positions
      const userPositionRepo = new UserPositionRepository(tenantDb);
      
      for (const member of team.members) {
        const usersInPosition = await userPositionRepo.findByPositionId(member.position_id);
        for (const userPosition of usersInPosition) {
          await notificationRepo.create({
            org_id: org._id,
            user_id: userPosition.user_id,
            type: 'emergency_alert',
            title: `EMERGENCY ACTIVATED: ${emergency.title}`,
            message: `Severity: ${emergency.severity}. You are part of the emergency response team.`,
            priority: 'critical',
            link: `/bcp/emergencies/${emergency._id}`,
            data: { emergency_id: emergency._id }
          });
        }
      }

      await repo.update(emergency._id, {
        status: 'team_notified',
        team_notified_at: new Date()
      });
    }

    logInfo('BCP Emergency triggered', { orgId: this.orgId, emergencyId: emergency._id, severity: emergency.severity });
    return emergency;
  }

  async getEmergencies(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findByOrgId(org._id, filters);
  }

  async getActiveEmergencies() {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findActive(org._id);
  }

  async getEmergencyById(emergencyId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    return await repo.findById(emergencyId);
  }

  async addEmergencyDiscussion(emergencyId, message, attachments, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    
    const discussionData = {
      participant_id: userId,
      message,
      attachments: attachments || []
    };

    return await repo.addDiscussion(emergencyId, discussionData);
  }

  async addEmergencyDecision(emergencyId, decisionData, userId, userRole) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    
    const decision = {
      ...decisionData,
      made_by: userId,
      role: userRole
    };

    return await repo.addDecision(emergencyId, decision);
  }

  async escalateEmergencyToTrustees(emergencyId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    const emergency = await repo.escalateToTrustees(emergencyId);

    // Notify all trustees
    // TODO: Get trustee users and send notifications

    logInfo('BCP Emergency escalated to trustees', { orgId: this.orgId, emergencyId });
    return emergency;
  }

  async addTrusteeEndorsement(emergencyId, endorsement, comments, trusteeId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    
    const endorsementData = {
      trustee_id: trusteeId,
      endorsement,
      comments
    };

    return await repo.addTrusteeEndorsement(emergencyId, endorsementData);
  }

  async resolveEmergency(emergencyId, resolutionData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    return await repo.resolve(emergencyId, resolutionData, userId);
  }

  async closeEmergency(emergencyId, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpEmergencyActivationRepository(tenantDb);
    return await repo.close(emergencyId, userId);
  }

  // ==================== AUTHORITY TRANSFER ====================

  async createAuthorityTransfer(transferData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }

    const transfer = await repo.create({
      ...transferData,
      org_id: org._id,
      created_by: userId
    });

    if (transfer.workflow_matrix_id) {
      try {
        const { ApprovalWorkflowService } = await import('./approvalWorkflowService.js');
        const workflowService = new ApprovalWorkflowService(this.orgId);
        const approvalRequest = await workflowService.createEmergencyTransferApprovalRequest(
          transfer._id,
          transfer.workflow_matrix_id,
          userId
        );
        await repo.update(transfer._id, { approval_request_id: approvalRequest._id });
        transfer.approval_request_id = approvalRequest._id;
      } catch (err) {
        logError('Failed to create emergency approval request for transfer', err, {
          transferId: transfer._id,
          matrixId: transfer.workflow_matrix_id
        });
      }
    }

    logInfo('BCP Authority Transfer created', { orgId: this.orgId, transferId: transfer._id });
    return transfer;
  }

  async getAuthorityTransfers(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findByOrgId(org._id, filters);
  }

  async getActiveAuthorityTransfers() {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findActive(org._id);
  }

  async getAuthorityTransferById(transferId) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    return await repo.findById(transferId);
  }

  async approveAuthorityTransfer(transferId, approved, comments, approverId, role) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    const userPositionRepo = new UserPositionRepository(tenantDb);
    const { TrainingRepository } = await import('../repositories/trainingRepository.js');
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const trainingRepo = new TrainingRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);

    // Load transfer first so we can enforce workflow-based approval, if any
    const existingTransfer = await repo.findById(transferId);
    if (!existingTransfer) {
      throw new AppError('Transfer not found', 404, 'NOT_FOUND');
    }

    // If called from the automated workflow system, skip manual position checks.
    // Otherwise, if this transfer is linked to an approval matrix workflow, only
    // position-holders in that matrix are allowed to approve.
    if (existingTransfer.workflow_matrix_id && role !== 'workflow') {
      const { ApprovalMatrixRepository } = await import('../repositories/approvalMatrixRepository.js');
      const matrixRepo = new ApprovalMatrixRepository(tenantDb);
      const matrix = await matrixRepo.findById(existingTransfer.workflow_matrix_id);
      if (!matrix) {
        throw new AppError('Workflow not found', 404, 'WORKFLOW_NOT_FOUND');
      }

      const workflowPositionIds = (matrix.rules || []).flatMap(r =>
        (r.requires_approval_from || [])
          .map(a => a.position_id?._id?.toString?.() || a.position_id?.toString?.())
          .filter(Boolean)
      );

      const approverPositionIds = new Set();
      const userPositions = await userPositionRepo.findByUserId(approverId, true);
      userPositions.forEach((up) => {
        const pid = up.position_id?._id?.toString?.() || up.position_id?.toString?.();
        if (pid) approverPositionIds.add(pid);
      });

      const { BoardMemberRepository: BMRepoClass } = await import('../repositories/boardMemberRepository.js');
      const bmRepo = new BMRepoClass(tenantDb);
      const org = await orgRepo.findOne();
      if (org) {
        const bm = await bmRepo.findByUserId(approverId, org._id);
        const bmPid = bm?.position_id?._id?.toString?.() || bm?.position_id?.toString?.();
        if (bmPid) approverPositionIds.add(bmPid);
      }

      const canApprove = workflowPositionIds.some((pid) => approverPositionIds.has(pid));
      if (!canApprove) {
        throw new AppError('You are not part of this emergency workflow', 403, 'NOT_IN_WORKFLOW');
      }
    }

    const approvalData = {
      approver_id: approverId,
      role,
      approved,
      comments,
      approved_at: new Date()
    };

    const transfer = await repo.addApproval(transferId, approvalData);

    if (transfer.status === 'active' && transfer.to_position_id && transfer.to_user_id) {
      const org = await orgRepo.findOne();
      if (org) {
        const fromPosOid = new mongoose.Types.ObjectId(String(transfer.from_position_id));
        const toPosOid = new mongoose.Types.ObjectId(String(transfer.to_position_id));
        const fromUserOid = transfer.from_user_id ? new mongoose.Types.ObjectId(String(transfer.from_user_id)) : null;
        const toUserOid = new mongoose.Types.ObjectId(String(transfer.to_user_id));

        logInfo('=== AUTHORITY TRANSFER POST-APPROVAL START ===', {
          transferId,
          fromPositionId: String(fromPosOid),
          toPositionId: String(toPosOid),
          fromUserId: fromUserOid ? String(fromUserOid) : null,
          toUserId: String(toUserOid)
        });

        const boardMemberRepo = new BoardMemberRepository(tenantDb);
        const { PolicyAcknowledgementRepository } = await import('../repositories/policyAcknowledgementRepository.js');
        const policyAckRepo = new PolicyAcknowledgementRepository(tenantDb);

        // ─── 1) DEACTIVATE from-user's board_member record (revoke position) ───
        if (fromUserOid) {
          try {
            const BoardMemberModel = boardMemberRepo.BoardMember;

            // Deactivate board_member (the source of truth for positions)
            const bmResult = await BoardMemberModel.updateMany(
              {
                user_id: fromUserOid,
                position_id: fromPosOid,
                org_id: org._id,
                is_active: true
              },
              {
                $set: { is_active: false, status: 'transferred' }
              }
            );
            logInfo('[TRANSFER STEP 1a] Deactivated from-user board_member', {
              transferId,
              matchedCount: bmResult.matchedCount,
              modifiedCount: bmResult.modifiedCount,
              fromUserId: String(fromUserOid),
              fromPositionId: String(fromPosOid)
            });

            // Also deactivate user_positions if any exist
            const UserPositionModel = userPositionRepo.UserPosition;
            const upResult = await UserPositionModel.updateMany(
              { user_id: fromUserOid, position_id: fromPosOid, is_active: true },
              { $set: { is_active: false, effective_to: new Date() } }
            );
            logInfo('[TRANSFER STEP 1b] Deactivated from-user user_positions', {
              transferId,
              matchedCount: upResult.matchedCount,
              modifiedCount: upResult.modifiedCount
            });
          } catch (err) {
            logError('[TRANSFER STEP 1] Failed to deactivate from-user position', err, { transferId, stack: err.stack });
          }
        }

        // ─── 2) Ensure to-user has the from-position assigned ───
        try {
          const BoardMemberModel = boardMemberRepo.BoardMember;
          const positionRepo = new PositionRepository(tenantDb);
          const fromPosition = await positionRepo.findById(fromPosOid);

          // Check if to-user already has a board_member record for this position
          const existingBm = await BoardMemberModel.findOne({
            user_id: toUserOid,
            position_id: fromPosOid,
            org_id: org._id,
            is_active: true
          });

          if (!existingBm) {
            // Get to-user's existing board_member to copy personal details
            const toBm = await boardMemberRepo.findByUserId(toUserOid, org._id);
            if (toBm) {
              await BoardMemberModel.create({
                org_id: org._id,
                user_id: toUserOid,
                position_id: fromPosOid,
                position: fromPosition?.title || 'Transferred Position',
                department: toBm.department,
                title: toBm.title,
                given_names: toBm.given_names,
                family_name: toBm.family_name,
                email: toBm.email,
                phone: toBm.phone,
                date_of_birth: toBm.date_of_birth,
                residential_address: toBm.residential_address,
                appointment_date: new Date(),
                has_system_access: true,
                is_active: true,
                status: 'active',
                invitation_status: 'accepted'
              });
              logInfo('[TRANSFER STEP 2a] Created board_member for to-user with from-position', {
                transferId,
                toUserId: String(toUserOid),
                positionTitle: fromPosition?.title
              });
            } else {
              logInfo('[TRANSFER STEP 2a] SKIPPED - to-user has no existing board_member to copy from', { transferId });
            }
          } else {
            logInfo('[TRANSFER STEP 2a] To-user already has board_member for this position', {
              transferId,
              existingBmId: existingBm._id.toString()
            });
          }

          // Also ensure user_positions link exists
          const existingLink = await userPositionRepo.findActiveByUserAndPosition(toUserOid, fromPosOid);
          if (!existingLink) {
            await userPositionRepo.create({
              org_id: org._id,
              user_id: toUserOid,
              position_id: fromPosOid,
              department_id: transfer.from_department_id,
              assigned_by: approverId
            });
            logInfo('[TRANSFER STEP 2b] Created user_position link for to-user', { transferId });
          }
        } catch (err) {
          logError('[TRANSFER STEP 2] Failed to assign position to to-user', err, { transferId, stack: err.stack });
        }

        // ─── 3) Shift training enrollments to the new person ───
        try {
          // Look up the to-user's board_member that holds the from-position
          // (we just created it in step 2, or it might already exist)
          const BoardMemberModel = boardMemberRepo.BoardMember;
          const toBmForFromPos = await BoardMemberModel.findOne({
            user_id: toUserOid,
            position_id: fromPosOid,
            org_id: org._id,
            is_active: true
          });
          // Fallback: use any active board_member for the to-user
          const toBoardMember = toBmForFromPos || await boardMemberRepo.findByUserId(toUserOid, org._id);

          logInfo('[TRANSFER STEP 3] Board member lookup', {
            transferId,
            toUserId: String(toUserOid),
            boardMemberFound: !!toBoardMember,
            boardMemberId: toBoardMember?._id?.toString() || null,
            matchedFromPosition: !!toBmForFromPos
          });

          const programs = await trainingRepo.findProgramsByOrg(org._id, { includeDraft: false });
          const fromPosStr = String(fromPosOid);
          const targetedPrograms = programs.filter(p =>
            Array.isArray(p.position_ids) &&
            p.position_ids.some(pid => String(pid) === fromPosStr)
          );

          logInfo('[TRANSFER STEP 3] Training programs', {
            transferId,
            totalPrograms: programs.length,
            targetedPrograms: targetedPrograms.length,
            targetedProgramIds: targetedPrograms.map(p => p._id.toString())
          });

          if (toBoardMember && targetedPrograms.length > 0) {
            let created = 0, reset = 0;
            for (const program of targetedPrograms) {
              const existing = await trainingRepo.findEnrollmentByProgramAndPerson(program._id, toBoardMember._id);
              if (existing) {
                await trainingRepo.updateEnrollment(existing._id, { status: 'assigned', completed_at: null });
                reset++;
              } else {
                await trainingRepo.createEnrollment({
                  training_program_id: program._id,
                  board_member_id: toBoardMember._id,
                  status: 'assigned'
                });
                created++;
              }
            }
            logInfo('[TRANSFER STEP 3] Training enrollments shifted', { transferId, created, reset });
          } else if (!toBoardMember) {
            logInfo('[TRANSFER STEP 3] SKIPPED - to-user is not a board member, cannot create enrollments', { transferId });
          }
        } catch (err) {
          logError('[TRANSFER STEP 3] Failed to shift training', err, { transferId, stack: err.stack });
        }

        // ─── 4a) Clear from-user's policy acknowledgements ───
        if (fromUserOid) {
          try {
            const fromAcks = await policyAckRepo.findByUserId(fromUserOid);
            logInfo('[TRANSFER STEP 4a] Policy acks for from-user', { transferId, count: fromAcks?.length || 0 });
            if (fromAcks?.length) {
              await policyAckRepo.deleteByUserId(fromUserOid);
              logInfo('[TRANSFER STEP 4a] Cleared policy acks', { transferId, count: fromAcks.length });
            }
          } catch (err) {
            logError('[TRANSFER STEP 4a] Failed to clear policy acks', err, { transferId });
          }
        }

        // ─── 4b) Transfer policy ownership from old board_member to new board_member ───
        try {
          const BoardMemberModel = boardMemberRepo.BoardMember;
          const fromBm = await BoardMemberModel.findOne({
            user_id: fromUserOid,
            position_id: fromPosOid,
            org_id: org._id
          });
          const toBm = await BoardMemberModel.findOne({
            user_id: toUserOid,
            position_id: fromPosOid,
            org_id: org._id,
            is_active: true
          });

          if (fromBm && toBm) {
            const { default: policySchema } = await import('../db/schemas/platform/policySchema.js');
            const PolicyModel = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
            const policyResult = await PolicyModel.updateMany(
              { org_id: org._id, policy_owner_id: fromBm._id },
              { $set: { policy_owner_id: toBm._id } }
            );
            logInfo('[TRANSFER STEP 4b] Policy ownership transferred', {
              transferId,
              fromBmId: fromBm._id.toString(),
              toBmId: toBm._id.toString(),
              matched: policyResult.matchedCount,
              modified: policyResult.modifiedCount
            });
          } else {
            logInfo('[TRANSFER STEP 4b] SKIPPED - board_member(s) not found', {
              transferId,
              fromBmFound: !!fromBm,
              toBmFound: !!toBm
            });
          }
        } catch (err) {
          logError('[TRANSFER STEP 4b] Failed to transfer policy ownership', err, { transferId });
        }

        // ─── 4c) Transfer meetings: add to-user to meetings where from-user was attendee ───
        if (fromUserOid) {
          try {
            const { default: meetingSchema } = await import('../db/schemas/platform/meetingSchema.js');
            const MeetingModel = tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);

            // Replace from-user with to-user in upcoming/scheduled meetings
            const meetingResult = await MeetingModel.updateMany(
              {
                status: { $in: ['scheduled', 'in_progress'] },
                'attendees.user_id': fromUserOid
              },
              {
                $set: { 'attendees.$[att].user_id': toUserOid }
              },
              { arrayFilters: [{ 'att.user_id': fromUserOid }] }
            );

            // Also transfer created_by for upcoming meetings
            const createdByResult = await MeetingModel.updateMany(
              {
                status: { $in: ['scheduled', 'in_progress'] },
                created_by: fromUserOid
              },
              { $set: { created_by: toUserOid } }
            );

            logInfo('[TRANSFER STEP 4c] Meetings transferred', {
              transferId,
              attendeesMatched: meetingResult.matchedCount,
              attendeesModified: meetingResult.modifiedCount,
              createdByMatched: createdByResult.matchedCount,
              createdByModified: createdByResult.modifiedCount
            });
          } catch (err) {
            logError('[TRANSFER STEP 4c] Failed to transfer meetings', err, { transferId });
          }
        }

        // ─── 5) Shift workflows: swap approver user in pending requests for the transferred position ───
        try {
          await this._shiftWorkflowPositions(tenantDb, org._id, fromPosOid, fromUserOid, toUserOid, transferId);
        } catch (err) {
          logError('[TRANSFER STEP 5] Failed to shift workflow positions', err, { transferId, stack: err.stack });
        }

        // ─── 6) Notifications + emails (fire-and-forget) ───
        this._sendTransferNotifications(tenantDb, transfer, org).catch(err =>
          logError('[TRANSFER STEP 6] Failed to send notifications', err, { transferId })
        );

        logInfo('=== AUTHORITY TRANSFER POST-APPROVAL COMPLETE ===', { transferId });
      } else {
        logError('=== AUTHORITY TRANSFER: org not found, skipping post-approval ===', null, { transferId });
      }
    } else {
      logInfo('Authority transfer not activated yet', {
        transferId,
        status: transfer.status,
        hasToPosition: !!transfer.to_position_id,
        hasToUser: !!transfer.to_user_id
      });
    }

    return transfer;
  }

  async updateAuthorityTransfer(transferId, updateData) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    return await repo.update(transferId, updateData);
  }

  async getExpiringAuthorityTransfers(daysAhead = 14) {
    const tenantDb = await this.getTenantDb();
    const repo = new BcpAuthorityTransferRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) return [];

    return await repo.findExpiring(org._id, daysAhead);
  }

  // ==================== DASHBOARD STATS ====================

  async getDashboardStats() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const teamRepo = new BcpEmergencyTeamRepository(tenantDb);
    const riskRepo = new BcpRiskRepository(tenantDb);
    const activationRepo = new BcpEmergencyActivationRepository(tenantDb);
    const transferRepo = new BcpAuthorityTransferRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    if (!org) {
      return {
        teams: 0,
        totalRisks: 0,
        criticalRisks: 0,
        activeEmergencies: 0,
        activeTransfers: 0,
        risksNeedingReview: 0
      };
    }

    const [teams, risks, activeEmergencies, activeTransfers, dueRisks] = await Promise.all([
      teamRepo.findByOrgId(org._id, 'active'),
      riskRepo.findByOrgId(org._id),
      activationRepo.findActive(org._id),
      transferRepo.findActive(org._id),
      riskRepo.findDueForReview(org._id)
    ]);

    const criticalRisks = risks.filter(r => r.impact_level === 'critical' && r.status !== 'closed').length;

    return {
      teams: teams.length,
      totalRisks: risks.length,
      criticalRisks,
      highRisks: risks.filter(r => r.impact_level === 'high' && r.status !== 'closed').length,
      activeEmergencies: activeEmergencies.length,
      activeTransfers: activeTransfers.length,
      risksNeedingReview: dueRisks.length,
      risksByCategory: {
        financial: risks.filter(r => r.category === 'financial').length,
        it_technology: risks.filter(r => r.category === 'it_technology').length,
        legal_compliance: risks.filter(r => r.category === 'legal_compliance').length,
        key_personnel: risks.filter(r => r.category === 'key_personnel').length
      }
    };
  }

  async _shiftWorkflowPositions(tenantDb, orgId, fromPosOid, fromUserOid, toUserOid, transferId) {
    const orgOid = new mongoose.Types.ObjectId(String(orgId));
    const fromOid = new mongoose.Types.ObjectId(String(fromPosOid));
    const fromUid = fromUserOid ? new mongoose.Types.ObjectId(String(fromUserOid)) : null;
    const toUid = toUserOid ? new mongoose.Types.ObjectId(String(toUserOid)) : null;

    // Approval Matrices: NO changes needed.
    // Matrices reference positions, not users. The position still exists with a new holder.
    logInfo('[TRANSFER STEP 5a] Approval matrices - no position swap needed (position unchanged, holder changed)', {
      transferId,
      fromPositionId: String(fromOid)
    });

    // Pending Approval Requests: swap approver_user_id where the step references the
    // transferred position. The position_id stays the same — only the person changes.
    if (!toUid) {
      logInfo('[TRANSFER STEP 5b] SKIPPED - no to-user ID', { transferId });
      return;
    }

    const { ApprovalRequestRepository } = await import('../repositories/approvalRequestRepository.js');
    const requestRepo = new ApprovalRequestRepository(tenantDb);
    const ApprovalRequest = requestRepo.ApprovalRequest;

    const stepUpdate = { 'approval_steps.$[step].approver_user_id': toUid };

    const requestResult = await ApprovalRequest.updateMany(
      {
        org_id: orgOid,
        status: 'pending',
        'approval_steps': {
          $elemMatch: { approver_position_id: fromOid, status: 'pending' }
        }
      },
      { $set: stepUpdate },
      { arrayFilters: [{ 'step.approver_position_id': fromOid, 'step.status': 'pending' }] }
    );

    logInfo('[TRANSFER STEP 5b] Pending approval requests - swapped approver_user_id', {
      transferId,
      positionId: String(fromOid),
      fromUserId: fromUid ? String(fromUid) : null,
      toUserId: String(toUid),
      matched: requestResult.matchedCount,
      modified: requestResult.modifiedCount
    });
  }

  async _sendTransferNotifications(tenantDb, transfer, org) {
    const notifRepo = new NotificationRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);
    const positionRepo = new PositionRepository(tenantDb);

    const [fromUser, toUser, position] = await Promise.all([
      transfer.from_user_id ? userRepo.findById(transfer.from_user_id) : null,
      transfer.to_user_id ? userRepo.findById(transfer.to_user_id) : null,
      transfer.from_position_id ? positionRepo.findById(transfer.from_position_id) : null
    ]);

    const positionTitle = position?.title || 'the transferred position';
    const transferCode = transfer.transfer_code || transfer._id.toString().slice(-6).toUpperCase();
    const fromName = fromUser ? `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim() : 'Previous holder';
    const toName = toUser ? `${toUser.first_name || ''} ${toUser.last_name || ''}`.trim() : 'New assignee';

    const notifications = [];

    if (transfer.from_user_id) {
      notifications.push({
        user_id: transfer.from_user_id,
        type: 'authority_transfer_revoked',
        title: `Position transferred – ${positionTitle}`,
        message: `Your responsibilities for ${positionTitle} have been transferred to ${toName}. Your access to associated workflows and approvals has been revoked.`,
        link: '/bcp',
        related_entity_id: transfer._id,
        related_entity_type: 'authority_transfer'
      });
    }

    if (transfer.to_user_id) {
      notifications.push({
        user_id: transfer.to_user_id,
        type: 'authority_transfer_assigned',
        title: `New role assigned – ${positionTitle}`,
        message: `You have been assigned the ${positionTitle} role, previously held by ${fromName}. Please complete any assigned trainings and policy acknowledgements.`,
        link: '/bcp',
        related_entity_id: transfer._id,
        related_entity_type: 'authority_transfer'
      });
    }

    if (notifications.length) {
      await notifRepo.createMany(notifications);
      logInfo('Authority transfer notifications created', { transferId: transfer._id, count: notifications.length });
    }

    const emailPromises = [];

    if (fromUser?.email) {
      emailPromises.push(
        emailService.sendAuthorityTransferEmail({
          to: fromUser.email,
          recipientName: fromName,
          isFromUser: true,
          positionTitle,
          otherPersonName: toName,
          transferCode,
          effectiveDate: transfer.effective_date
        })
      );
    }

    if (toUser?.email) {
      emailPromises.push(
        emailService.sendAuthorityTransferEmail({
          to: toUser.email,
          recipientName: toName,
          isFromUser: false,
          positionTitle,
          otherPersonName: fromName,
          transferCode,
          effectiveDate: transfer.effective_date
        })
      );
    }

    if (emailPromises.length) {
      const results = await Promise.allSettled(emailPromises);
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          logError(`Authority transfer email ${i} failed`, r.reason, { transferId: transfer._id });
        }
      });
      logInfo('Authority transfer emails sent', { transferId: transfer._id, count: emailPromises.length });
    }
  }
}
