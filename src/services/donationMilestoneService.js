import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { DonationMilestoneRepository } from '../repositories/donationMilestoneRepository.js';
import { FundingAgreementRepository } from '../repositories/fundingAgreementRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';

export class DonationMilestoneService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async _getTenantDb() {
    return getTenantConnection(this.orgId);
  }

  async _getOrgObjectId(tenantDb) {
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    return org._id;
  }

  async createMilestone(payload, submittedBy) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const milestoneRepo = new DonationMilestoneRepository(tenantDb);
    const agreementRepo = new FundingAgreementRepository(tenantDb);

    const agreement = await agreementRepo.findById(payload.funding_agreement_id);
    if (!agreement) {
      throw new AppError('Funding agreement not found', 404, 'AGREEMENT_NOT_FOUND');
    }

    const milestone = await milestoneRepo.create({
      org_id: orgObjectId,
      funding_agreement_id: payload.funding_agreement_id,
      title: payload.title,
      milestone_type: payload.milestone_type || 'reporting',
      amount: Number(payload.amount || 0),
      currency: payload.currency || agreement.currency || 'AUD',
      due_date: payload.due_date,
      status: payload.status || 'upcoming',
      evidence_required: payload.evidence_required || '',
      documents: payload.documents || [],
      metadata: payload.metadata || {}
    });

    // Trigger approval workflow using "donation_milestone" action_type
    const workflowService = new ApprovalWorkflowService(this.orgId);
    await workflowService.createDonationMilestoneApprovalRequest(
      milestone._id.toString(),
      submittedBy,
      milestone.amount
    );

    return milestone;
  }

  async listMilestones(filters = {}) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const milestoneRepo = new DonationMilestoneRepository(tenantDb);
    return milestoneRepo.findByOrg(orgObjectId, filters);
  }
}

