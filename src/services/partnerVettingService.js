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

  async uploadVettingCheckDocument(partnerId, checkIndex, file) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }

    const idx = Number(checkIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new AppError('Invalid check index', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(partner.vetting_checks) || !partner.vetting_checks[idx]) {
      throw new AppError('Vetting check not found', 404, 'VETTING_CHECK_NOT_FOUND');
    }

    const { key } = await uploadToS3(
      file.buffer,
      file.originalname,
      file.mimetype,
      this.orgId,
      'partner_vetting_check_documents'
    );

    return await repo.addVettingCheckDocument(partnerId, idx, {
      file_path: key,
      file_name: file.originalname,
      uploaded_at: new Date()
    });
  }

  async streamVettingCheckDocument(partnerId, checkIndex, docIndex, rangeHeader) {
    const tenantDb = await this.getTenantDb();
    const repo = new PartnerVettingRepository(tenantDb);
    const partner = await repo.findById(partnerId);
    if (!partner) {
      throw new AppError('Partner not found', 404, 'PARTNER_NOT_FOUND');
    }
    const cIdx = Number(checkIndex);
    const dIdx = Number(docIndex);
    if (!Number.isInteger(cIdx) || cIdx < 0 || !Number.isInteger(dIdx) || dIdx < 0) {
      throw new AppError('Invalid document index', 400, 'VALIDATION_ERROR');
    }
    const check = partner.vetting_checks?.[cIdx];
    const doc = check?.documents?.[dIdx];
    if (!doc?.file_path) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    return await getFileStream(doc.file_path, rangeHeader);
  }
}
