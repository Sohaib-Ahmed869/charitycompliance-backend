/**
 * BCP Repository
 * 
 * Data access layer for Business Continuity Plan operations
 */

import bcpEmergencyTeamSchema from '../db/schemas/platform/bcpEmergencyTeamSchema.js';
import bcpRiskSchema from '../db/schemas/platform/bcpRiskSchema.js';
import bcpCredentialVaultSchema from '../db/schemas/platform/bcpCredentialVaultSchema.js';
import bcpEmergencyActivationSchema from '../db/schemas/platform/bcpEmergencyActivationSchema.js';
import bcpAuthorityTransferSchema from '../db/schemas/platform/bcpAuthorityTransferSchema.js';

export class BcpEmergencyTeamRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.BcpEmergencyTeam = tenantDb.models.BcpEmergencyTeam || tenantDb.model('BcpEmergencyTeam', bcpEmergencyTeamSchema);
  }

  async create(data) {
    const team = new this.BcpEmergencyTeam(data);
    return await team.save();
  }

  async findById(id) {
    return await this.BcpEmergencyTeam.findById(id)
      .populate('members.position_id', 'title code department_id')
      .populate('members.backup_position_id', 'title code')
      .populate('created_by', 'first_name last_name email')
      .lean();
  }

  async findByOrgId(orgId, status = 'active') {
    const query = { org_id: orgId };
    if (status) query.status = status;
    
    return await this.BcpEmergencyTeam.find(query)
      .populate('members.position_id', 'title code department_id')
      .populate('members.backup_position_id', 'title code')
      .sort({ created_at: -1 })
      .lean();
  }

  async update(id, data) {
    return await this.BcpEmergencyTeam.findByIdAndUpdate(id, data, { new: true })
      .populate('members.position_id', 'title code department_id')
      .lean();
  }

  async delete(id) {
    return await this.BcpEmergencyTeam.findByIdAndUpdate(id, { status: 'archived' }, { new: true });
  }
}

export class BcpRiskRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.BcpRisk = tenantDb.models.BcpRisk || tenantDb.model('BcpRisk', bcpRiskSchema);
  }

  async create(data) {
    const risk = new this.BcpRisk(data);
    return await risk.save();
  }

  async findById(id) {
    return await this.BcpRisk.findById(id)
      .populate('assigned_to_position_id', 'title code')
      .populate('created_by', 'first_name last_name email')
      .populate('it_details.credential_owner_position_id', 'title code')
      .populate('legal_details.backup_authorized_person_position_id', 'title code')
      .populate('personnel_details.key_person_position_id', 'title code')
      .populate('personnel_details.successor_position_id', 'title code')
      .lean();
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    
    if (filters.category) query.category = filters.category;
    if (filters.status) query.status = filters.status;
    if (filters.impact_level) query.impact_level = filters.impact_level;
    
    return await this.BcpRisk.find(query)
      .populate('assigned_to_position_id', 'title code')
      .populate('created_by', 'first_name last_name email')
      .sort({ risk_score: -1, created_at: -1 })
      .lean();
  }

  async findDueForReview(orgId) {
    return await this.BcpRisk.find({
      org_id: orgId,
      status: { $ne: 'closed' },
      next_review_date: { $lte: new Date() }
    })
    .populate('assigned_to_position_id', 'title code')
    .lean();
  }

  async update(id, data) {
    return await this.BcpRisk.findByIdAndUpdate(id, { ...data, updated_at: new Date() }, { new: true })
      .populate('assigned_to_position_id', 'title code')
      .lean();
  }

  async addEscalation(id, escalationData) {
    return await this.BcpRisk.findByIdAndUpdate(
      id,
      { 
        $push: { escalation_history: escalationData },
        status: 'escalated',
        updated_at: new Date()
      },
      { new: true }
    ).lean();
  }

  async getStats(orgId) {
    const stats = await this.BcpRisk.aggregate([
      { $match: { org_id: orgId } },
      {
        $group: {
          _id: '$category',
          total: { $sum: 1 },
          critical: { $sum: { $cond: [{ $eq: ['$impact_level', 'critical'] }, 1, 0] } },
          high: { $sum: { $cond: [{ $eq: ['$impact_level', 'high'] }, 1, 0] } },
          mitigated: { $sum: { $cond: [{ $eq: ['$status', 'mitigated'] }, 1, 0] } }
        }
      }
    ]);
    return stats;
  }
}

export class BcpCredentialVaultRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.BcpCredentialVault = tenantDb.models.BcpCredentialVault || tenantDb.model('BcpCredentialVault', bcpCredentialVaultSchema);
  }

  async create(data) {
    const credential = new this.BcpCredentialVault(data);
    return await credential.save();
  }

  async findById(id) {
    return await this.BcpCredentialVault.findById(id)
      .populate('owner_position_id', 'title code')
      .populate('backup_owner_position_id', 'title code')
      .populate('created_by', 'first_name last_name email')
      .lean();
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId, status: { $ne: 'archived' } };
    
    if (filters.category) query.category = filters.category;
    
    return await this.BcpCredentialVault.find(query)
      .populate('owner_position_id', 'title code')
      .populate('backup_owner_position_id', 'title code')
      .select('-credentials.password_encrypted -credentials.additional_info_encrypted')
      .sort({ category: 1, name: 1 })
      .lean();
  }

  async findExpiringCredentials(orgId, daysAhead = 30) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    
    return await this.BcpCredentialVault.find({
      org_id: orgId,
      status: 'active',
      renewal_date: { $lte: futureDate, $gte: new Date() }
    })
    .populate('owner_position_id', 'title code')
    .lean();
  }

  async update(id, data) {
    return await this.BcpCredentialVault.findByIdAndUpdate(id, { ...data, updated_at: new Date() }, { new: true }).lean();
  }

  async addAccessRequest(id, requestData) {
    return await this.BcpCredentialVault.findByIdAndUpdate(
      id,
      { $push: { access_requests: requestData }, updated_at: new Date() },
      { new: true }
    ).lean();
  }

  async approveAccessRequest(id, requestId, trusteeId, approved, comments) {
    const credential = await this.BcpCredentialVault.findById(id);
    const request = credential.access_requests.id(requestId);
    
    if (request) {
      request.approvals.push({
        trustee_id: trusteeId,
        approved,
        approved_at: new Date(),
        comments
      });
      
      // Check if required approvals met
      const approvedCount = request.approvals.filter(a => a.approved).length;
      if (approvedCount >= request.required_approvals) {
        request.status = 'approved';
      } else if (request.approvals.some(a => !a.approved)) {
        request.status = 'denied';
      }
      
      await credential.save();
    }
    
    return credential;
  }

  async logAccess(id, accessData) {
    return await this.BcpCredentialVault.findByIdAndUpdate(
      id,
      { $push: { access_logs: accessData } },
      { new: true }
    ).lean();
  }
}

export class BcpEmergencyActivationRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.BcpEmergencyActivation = tenantDb.models.BcpEmergencyActivation || tenantDb.model('BcpEmergencyActivation', bcpEmergencyActivationSchema);
  }

  async create(data) {
    const activation = new this.BcpEmergencyActivation(data);
    return await activation.save();
  }

  async findById(id) {
    return await this.BcpEmergencyActivation.findById(id)
      .populate('triggered_by', 'first_name last_name email')
      .populate('emergency_team_id')
      .populate('linked_risk_id')
      .populate('discussion_log.participant_id', 'first_name last_name email')
      .populate('decisions.made_by', 'first_name last_name email')
      .populate('trustee_endorsements.trustee_id', 'first_name last_name email')
      .lean();
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    
    if (filters.status) query.status = filters.status;
    if (filters.category) query.category = filters.category;
    if (filters.severity) query.severity = filters.severity;
    
    return await this.BcpEmergencyActivation.find(query)
      .populate('triggered_by', 'first_name last_name email')
      .populate('emergency_team_id', 'team_name')
      .sort({ triggered_at: -1 })
      .lean();
  }

  async findActive(orgId) {
    return await this.BcpEmergencyActivation.find({
      org_id: orgId,
      status: { $in: ['triggered', 'team_notified', 'in_discussion', 'escalated_to_trustees'] }
    })
    .populate('triggered_by', 'first_name last_name email')
    .populate('emergency_team_id', 'team_name')
    .sort({ triggered_at: -1 })
    .lean();
  }

  async update(id, data) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(id, { ...data, updated_at: new Date() }, { new: true }).lean();
  }

  async addDiscussion(id, discussionData) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(
      id,
      { 
        $push: { discussion_log: discussionData },
        status: 'in_discussion',
        'discussion_phase.started_at': new Date(),
        updated_at: new Date()
      },
      { new: true }
    ).lean();
  }

  async addDecision(id, decisionData) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(
      id,
      { $push: { decisions: decisionData }, updated_at: new Date() },
      { new: true }
    ).lean();
  }

  async escalateToTrustees(id) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(
      id,
      { 
        status: 'escalated_to_trustees',
        escalated_to_trustees_at: new Date(),
        updated_at: new Date()
      },
      { new: true }
    ).lean();
  }

  async addTrusteeEndorsement(id, endorsementData) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(
      id,
      { $push: { trustee_endorsements: endorsementData }, updated_at: new Date() },
      { new: true }
    ).lean();
  }

  async resolve(id, resolutionData, userId) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(
      id,
      {
        status: 'resolved',
        resolution: { ...resolutionData, resolved_by: userId, resolved_at: new Date() },
        updated_at: new Date()
      },
      { new: true }
    ).lean();
  }

  async close(id, userId) {
    return await this.BcpEmergencyActivation.findByIdAndUpdate(
      id,
      {
        status: 'closed',
        closed_at: new Date(),
        closed_by: userId,
        updated_at: new Date()
      },
      { new: true }
    ).lean();
  }
}

export class BcpAuthorityTransferRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.BcpAuthorityTransfer = tenantDb.models.BcpAuthorityTransfer || tenantDb.model('BcpAuthorityTransfer', bcpAuthorityTransferSchema);
  }

  async create(data) {
    const transfer = new this.BcpAuthorityTransfer(data);
    return await transfer.save();
  }

  async findById(id) {
    return await this.BcpAuthorityTransfer.findById(id)
      .populate('from_user_id', 'first_name last_name email')
      .populate('to_user_id', 'first_name last_name email')
      .populate('from_position_id', 'title code')
      .populate('to_position_id', 'title code')
      .populate('from_department_id', 'name')
      .populate('to_department_id', 'name')
      .populate('created_by', 'first_name last_name email')
      .populate('approvals.approver_id', 'first_name last_name email')
      .lean();
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    
    if (filters.status) query.status = filters.status;
    
    return await this.BcpAuthorityTransfer.find(query)
      .populate('from_user_id', 'first_name last_name email')
      .populate('to_user_id', 'first_name last_name email')
      .populate('from_position_id', 'title code')
      .populate('to_position_id', 'title code')
      .populate('from_department_id', 'name')
      .populate('to_department_id', 'name')
      .sort({ created_at: -1 })
      .lean();
  }

  async findActive(orgId) {
    const now = new Date();
    return await this.BcpAuthorityTransfer.find({
      org_id: orgId,
      status: 'active',
      effective_date: { $lte: now },
      $or: [
        { end_date: null },
        { end_date: { $gte: now } }
      ]
    })
    .populate('from_user_id', 'first_name last_name email')
    .populate('to_user_id', 'first_name last_name email')
    .populate('from_position_id', 'title code')
    .populate('to_position_id', 'title code')
    .lean();
  }

  async update(id, data) {
    return await this.BcpAuthorityTransfer.findByIdAndUpdate(id, { ...data, updated_at: new Date() }, { new: true }).lean();
  }

  async addApproval(id, approvalData) {
    const transfer = await this.BcpAuthorityTransfer.findByIdAndUpdate(
      id,
      { $push: { approvals: approvalData }, updated_at: new Date() },
      { new: true }
    ).lean();
    
    const workflowApproved = transfer.approvals.some(a => a.role === 'workflow' && a.approved);
    const trusteeApproved = transfer.approvals.some(a => a.role === 'trustee' && a.approved);
    const hasAnyApproval = transfer.approvals.some(a => a.approved === true);
    // Only activate if at least one approval is positive AND requirements are met
    if (hasAnyApproval && (workflowApproved || (!transfer.requires_trustee_approval && hasAnyApproval) || trusteeApproved)) {
      await this.BcpAuthorityTransfer.findByIdAndUpdate(id, { status: 'active' });
      transfer.status = 'active';
    }
    
    return transfer;
  }

  async findExpiring(orgId, daysAhead = 14) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    
    return await this.BcpAuthorityTransfer.find({
      org_id: orgId,
      status: 'active',
      end_date: { $lte: futureDate, $gte: new Date() }
    })
    .populate('from_position_id', 'title code')
    .populate('to_position_id', 'title code')
    .lean();
  }
}
