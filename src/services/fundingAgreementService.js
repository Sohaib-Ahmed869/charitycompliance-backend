/**
 * Funding Agreement Service
 *
 * Business logic for funding agreements.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { FundingAgreementRepository } from '../repositories/fundingAgreementRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { logInfo } from '../utils/logger.js';
import emailService from './emailService.js';
import crypto from 'crypto';

export class FundingAgreementService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async _getOrgObjectId() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    return org._id;
  }

  async createAgreement(data) {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new FundingAgreementRepository(tenantDb);

    const agreement = await repo.create({
      org_id: orgId,
      agreement_title: data.agreement_title,
      partner_name: data.partner_name || '',
      partner_email: data.partner_email || '',
      agreement_type: data.agreement_type || '',
      currency: data.currency || 'AUD',
      total_amount: Number(data.total_amount || 0),
      status: data.status || 'pending',
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      description: data.description || '',
      payment_terms: data.payment_terms || '',
      reporting_requirements: data.reporting_requirements || '',
      metadata: data.metadata || {}
    });

    logInfo('Funding agreement created', { fundingAgreementId: agreement._id });

    // Trigger approval workflow if configured
    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      const submittedBy = data.submitted_by || data.created_by;
      await workflowService.createFundingAgreementApprovalRequest(agreement._id, submittedBy);
    } catch (err) {
      // If there's no approval workflow for funding agreements, auto-approve
      const errCode = err?.code;
      const isNoWorkflow =
        err?.name === 'CastError' ||
        errCode === 'INVALID_ID' ||
        errCode === 'NO_APPROVAL_MATRIX' ||
        errCode === 'NO_MATCHING_RULE';

      if (!isNoWorkflow) {
        await repo.delete(agreement._id);
        throw err;
      }

      logInfo('No approval workflow for funding agreements; auto-approving', {
        fundingAgreementId: agreement._id,
        errCode: errCode || err?.name
      });

      await repo.update(agreement._id, {
        status: 'approved',
        approval_matrix_id: null,
        approval_request_id: null
      });
    }

    return await repo.findById(agreement._id);
  }

  async getAgreements(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new FundingAgreementRepository(tenantDb);
    return await repo.findByOrgId(orgId, filters);
  }

  async getAgreementCounts() {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new FundingAgreementRepository(tenantDb);
    return await repo.getCountsByOrg(orgId);
  }

  async getAgreementById(agreementId) {
    const tenantDb = await this.getTenantDb();
    const repo = new FundingAgreementRepository(tenantDb);
    const agreement = await repo.findById(agreementId);
    if (!agreement) {
      throw new AppError('Funding agreement not found', 404, 'AGREEMENT_NOT_FOUND');
    }
    return agreement;
  }

  async signAgreementInternallyAndEmailPartner(agreementId, user, { signature_data, notes, partner_email }) {
    const tenantDb = await this.getTenantDb();
    const repo = new FundingAgreementRepository(tenantDb);
    const agreement = await repo.findById(agreementId);
    if (!agreement) throw new AppError('Funding agreement not found', 404, 'AGREEMENT_NOT_FOUND');

    if (String(agreement.status) !== 'approved') {
      throw new AppError('Only approved funding agreements can be signed', 400, 'AGREEMENT_NOT_APPROVED');
    }

    if (agreement?.internal_signature?.signed_at) {
      throw new AppError('Funding agreement is already signed internally', 409, 'AGREEMENT_ALREADY_SIGNED_INTERNAL');
    }

    const resolvedPartnerEmail = String(partner_email || agreement.partner_email || '').trim().toLowerCase();
    if (!resolvedPartnerEmail) {
      throw new AppError('Partner email is required to request partner signature', 400, 'PARTNER_EMAIL_REQUIRED');
    }

    // Generate (or refresh) partner signing token
    const tokenTtlMs = 1000 * 60 * 60 * 24 * 14; // 14 days
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + tokenTtlMs);

    const signerName =
      String(user?.first_name || user?.firstName || '').trim() ||
      String(user?.name || '').trim() ||
      'Internal user';

    const updated = await repo.update(agreementId, {
      partner_email: resolvedPartnerEmail,
      internal_signature: {
        signed_at: new Date(),
        signed_by_user_id: user?._id || user?.userId || null,
        signer_name: signerName,
        signature_data: signature_data,
        notes: String(notes || '').trim()
      },
      partner_sign_token: token,
      partner_sign_token_expires_at: expiresAt
    });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const publicToken = `${this.orgId}.${token}`;
    const signLink = `${baseUrl}/public/funding-agreements/sign/${publicToken}`;

    await emailService.sendFundingAgreementPartnerSignatureRequestEmail({
      to: resolvedPartnerEmail,
      partnerName: updated?.partner_name || '',
      agreementTitle: updated?.agreement_title || 'Funding agreement',
      signLink,
      expiryDate: expiresAt
    });

    return updated;
  }
}
