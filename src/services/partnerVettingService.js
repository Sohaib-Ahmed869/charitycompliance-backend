/**
 * Partner Vetting Service
 *
 * Business logic for funding partner due diligence.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { PartnerVettingRepository } from '../repositories/partnerVettingRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToS3, getFileStream } from './s3Service.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { logInfo } from '../utils/logger.js';

const DEFAULT_CHECKS = [
  { name: 'DFAT Consolidated List Check', status: 'completed', ranking: '' },
  { name: 'AML/CTF Assessment', status: 'completed', ranking: 'medium' },
  { name: 'AML Risk Ranking', status: 'completed', ranking: 'medium' },
  { name: 'Sanctions Screening', status: 'completed', ranking: '' },
  { name: 'PEP Check', status: 'completed', ranking: '' },
  { name: 'Adverse Media Screening', status: 'completed', ranking: '' }
];

const DEFAULT_DOCUMENTS = [
  { name: 'Certificate of Incorporation', status: 'pending' },
  { name: 'ACNC Registration Proof', status: 'completed' },
  { name: 'ABN Certificate', status: 'completed' },
  { name: 'AML/CTF Policy', status: 'completed' },
  { name: 'Financial Statements', status: 'pending' }
];

export class PartnerVettingService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  static _normCountry(value) {
    return String(value || '').trim().toLowerCase();
  }

  static _isOverseasPartner(partnerCountry, homeCountry) {
    const p = PartnerVettingService._normCountry(partnerCountry);
    const h = PartnerVettingService._normCountry(homeCountry || 'Australia');
    if (!p) return false;
    return p !== h;
  }

  async _resolveHomeCountry() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    const raw = org?.address_country || 'Australia';
    return String(raw).trim() || 'Australia';
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

  async createPartner(data) {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new PartnerVettingRepository(tenantDb);

    const reviewDate = data.review_date
      ? new Date(data.review_date)
      : new Date(new Date().setFullYear(new Date().getFullYear() + 1));

    const homeCountry = await this._resolveHomeCountry();
    const partnerCountry = data.country || '';
    const overseasAuto = PartnerVettingService._isOverseasPartner(partnerCountry, homeCountry);
    const incomingGdpr = data.data_gdpr_compliance && typeof data.data_gdpr_compliance === 'object'
      ? data.data_gdpr_compliance
      : {};

    const partner = await repo.create({
      org_id: orgId,
      organization_name: data.organization_name,
      trading_name: data.trading_name || '',
      abn_registration_number: data.abn_registration_number || '',
      country: data.country || '',
      address: data.address || '',
      website: data.website || '',
      contact: {
        name: data.contact?.name || data.contact_name || '',
        email: data.contact?.email || data.contact_email || '',
        phone: data.contact?.phone || data.contact_phone || ''
      },
      status: data.status || 'pending',
      risk_rating: data.risk_rating || 'medium',
      review_date: reviewDate,
      vetting_checks: data.vetting_checks?.length ? data.vetting_checks : DEFAULT_CHECKS,
      documents: data.documents?.length ? data.documents : DEFAULT_DOCUMENTS,
      risk_assessment: {
        overall_risk_rating: data.risk_assessment?.overall_risk_rating || data.risk_rating || 'medium',
        review_date: data.risk_assessment?.review_date || reviewDate,
        notes: data.risk_assessment?.notes || ''
      },
      data_gdpr_compliance: {
        backup_verified: !!incomingGdpr.backup_verified,
        storage_location: String(incomingGdpr.storage_location || '').trim(),
        gdpr_confirmed: !!incomingGdpr.gdpr_confirmed,
        dpa_signed: !!incomingGdpr.dpa_signed,
        breach_process_confirmed: !!incomingGdpr.breach_process_confirmed,
        overseas_partner_auto: overseasAuto
      },
      metadata: data.metadata || {}
    });

    logInfo('Partner created', { partnerId: partner._id });

    // Trigger approval workflow if configured
    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      const submittedBy = data.submitted_by || data.created_by;
      await workflowService.createPartnerVettingApprovalRequest(partner._id, submittedBy);
    } catch (err) {
      // If there's no approval workflow for partner vetting, auto-approve
      const errCode = err?.code;
      const isNoWorkflow =
        err?.name === 'CastError' ||
        errCode === 'INVALID_ID' ||
        errCode === 'NO_APPROVAL_MATRIX' ||
        errCode === 'NO_MATCHING_RULE';

      if (!isNoWorkflow) {
        await repo.delete(partner._id);
        throw err;
      }

      logInfo('No approval workflow for partner vetting; auto-approving', {
        partnerId: partner._id,
        errCode: errCode || err?.name
      });

      await repo.update(partner._id, {
        status: 'approved',
        approval_matrix_id: null,
        approval_request_id: null
      });
    }

    return await repo.findById(partner._id);
  }

  async getPartners(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new PartnerVettingRepository(tenantDb);
    return await repo.findByOrgId(orgId, filters);
  }

  async getPartnerCounts() {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new PartnerVettingRepository(tenantDb);
    return await repo.getCountsByOrg(orgId);
  }

  async getPartnerById(partnerId) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }
    return partner;
  }

  async updatePartner(partnerId, updateData) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }

    const normalized = { ...updateData };
    if (updateData.contact_name || updateData.contact_email || updateData.contact_phone) {
      normalized.contact = {
        name: updateData.contact_name || partner.contact?.name || '',
        email: updateData.contact_email || partner.contact?.email || '',
        phone: updateData.contact_phone || partner.contact?.phone || ''
      };
    }

    if (updateData.risk_assessment) {
      normalized.risk_assessment = {
        ...partner.risk_assessment,
        ...updateData.risk_assessment
      };
    }

    const homeCountry = await this._resolveHomeCountry();
    const nextCountry = updateData.country !== undefined ? updateData.country : partner.country;
    const overseasAuto = PartnerVettingService._isOverseasPartner(nextCountry, homeCountry);

    const rawGdpr = partner.data_gdpr_compliance;
    const existingGdpr =
      rawGdpr && typeof rawGdpr === 'object'
        ? {
            ...(typeof rawGdpr.toObject === 'function' ? rawGdpr.toObject() : { ...rawGdpr })
          }
        : {};

    if (updateData.data_gdpr_compliance !== undefined) {
      const inc = updateData.data_gdpr_compliance && typeof updateData.data_gdpr_compliance === 'object'
        ? updateData.data_gdpr_compliance
        : {};
      normalized.data_gdpr_compliance = {
        ...existingGdpr,
        backup_verified: inc.backup_verified !== undefined ? !!inc.backup_verified : !!existingGdpr.backup_verified,
        storage_location:
          inc.storage_location !== undefined
            ? String(inc.storage_location || '').trim()
            : String(existingGdpr.storage_location || '').trim(),
        gdpr_confirmed: inc.gdpr_confirmed !== undefined ? !!inc.gdpr_confirmed : !!existingGdpr.gdpr_confirmed,
        dpa_signed: inc.dpa_signed !== undefined ? !!inc.dpa_signed : !!existingGdpr.dpa_signed,
        breach_process_confirmed:
          inc.breach_process_confirmed !== undefined
            ? !!inc.breach_process_confirmed
            : !!existingGdpr.breach_process_confirmed,
        overseas_partner_auto: overseasAuto
      };
    } else if (updateData.country !== undefined) {
      normalized.data_gdpr_compliance = {
        ...existingGdpr,
        overseas_partner_auto: overseasAuto
      };
    }

    return await repo.update(partnerId, normalized);
  }

  async deletePartner(partnerId) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }
    await repo.delete(partnerId);
    return { deleted: true };
  }

  async uploadDocument(partnerId, docIndex, file) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }
    
    // If documents array doesn't exist or index is out of bounds, auto-create placeholder documents
    if (!Array.isArray(partner.documents) || !partner.documents[docIndex]) {
      // Initialize documents array if missing
      if (!Array.isArray(partner.documents)) {
        partner.documents = DEFAULT_DOCUMENTS.map(d => ({ ...d }));
      }
      
      // Extend array if index is out of bounds
      while (partner.documents.length <= docIndex) {
        partner.documents.push({
          name: `Document ${partner.documents.length + 1}`,
          status: 'pending',
          file_path: null,
          file_name: null
        });
      }
      
      // Save the extended documents structure
      await repo.update(partnerId, { documents: partner.documents });
    }

    const { key } = await uploadToS3(
      file.buffer,
      file.originalname,
      file.mimetype,
      this.orgId,
      'partner_documents'
    );

    return await repo.updateDocument(partnerId, docIndex, {
      file_path: key,
      file_name: file.originalname,
      status: 'completed'
    });
  }

  async streamDocument(partnerId, docIndex, rangeHeader) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }
    const doc = partner.documents?.[docIndex];
    if (!doc?.file_path) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    return await getFileStream(doc.file_path, rangeHeader);
  }
}
