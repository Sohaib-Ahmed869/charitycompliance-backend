/**
 * Donor Service
 *
 * Business logic for donor management.
 */

import crypto from 'crypto';
import { DonorRepository } from '../repositories/donorRepository.js';
import { DonorRefundRepository } from '../repositories/donorRefundRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';

export class DonorService {
  constructor(orgId, tenantDb) {
    this.orgId = orgId;
    this.tenantDb = tenantDb;
    this.repo = new DonorRepository(tenantDb);
  }

  async createDonor(payload, submittedBy) {
    if (!payload?.name) {
      throw new AppError('Donor name is required', 400, 'VALIDATION_ERROR');
    }

    // Map donor size to expected_annual_donation for approval matching
    // small=1, medium=2, large=3
    const sizeToAmountMap = {
      'small': 1,
      'medium': 2,
      'large': 3
    };
    const donorSize = payload.size || 'small';
    const expectedAmount = sizeToAmountMap[donorSize] || 1;

    const donor = await this.repo.create({
      ...payload,
      org_id: this.orgId,
      size: donorSize,
      expected_annual_donation: expectedAmount
    });

    // Trigger approval workflow
    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      await workflowService.createDonorApprovalRequest(donor._id.toString(), submittedBy);
    } catch (err) {
      // Re-throw all errors - don't silently fail
      // Client needs to know if workflow wasn't configured
      console.error('Failed to create donor approval workflow:', {
        donorId: donor._id,
        size: donorSize,
        submittedBy,
        error: err.message,
        code: err.code
      });
      throw err;
    }

    return donor;
  }

  async listDonors(filters = {}) {
    return this.repo.findAllByOrg(this.orgId, filters);
  }

  async getDonorById(id) {
    const donor = await this.repo.findById(id);
    if (!donor || String(donor.org_id) !== String(this.orgId)) {
      throw new AppError('Donor not found', 404, 'NOT_FOUND');
    }
    return donor;
  }

  async updateDonor(id, updateData) {
    const donor = await this.repo.update(id, updateData);
    if (!donor || String(donor.org_id) !== String(this.orgId)) {
      throw new AppError('Donor not found', 404, 'NOT_FOUND');
    }
    return donor;
  }

  /**
   * Initiate a donor refund. Creates a DonorRefund record in
   * `awaiting_donor_form` state with a unique token the donor will use to
   * complete the public refund form.
   */
  async initiateDonorRefund(donorId, userId, payload = {}) {
    const donor = await this.repo.findById(donorId);
    if (!donor || String(donor.org_id) !== String(this.orgId)) {
      throw new AppError('Donor not found', 404, 'NOT_FOUND');
    }

    const refundRepo = new DonorRefundRepository(this.tenantDb);

    // Block creating a new refund while one is still in progress.
    const active = await refundRepo.findActiveByDonorId(donorId);
    if (active) {
      throw new AppError(
        'This donor already has an active refund in progress',
        400,
        'REFUND_ALREADY_IN_PROGRESS'
      );
    }

    const token = crypto.randomBytes(24).toString('hex');
    const donorContactEmail =
      payload.donor_contact_email
      || donor.primary_contact?.email
      || donor.email
      || '';

    const refund = await refundRepo.create({
      org_key: this.orgId,
      org_id: this.orgId,
      donor_id: donorId,
      token,
      status: 'awaiting_donor_form',
      initiated_at: new Date(),
      initiated_by: userId,
      donor_contact_email: donorContactEmail,
      admin_notes: payload.admin_notes || '',
    });

    return refund;
  }

  /**
   * List donor refunds for this org, with optional filters.
   */
  async listDonorRefunds(filters = {}) {
    const refundRepo = new DonorRefundRepository(this.tenantDb);
    let refunds = await refundRepo.findByOrgKey(this.orgId, filters.donorId || null);

    if (filters.status) {
      refunds = refunds.filter((r) => r.status === filters.status);
    }
    if (filters.search) {
      const q = String(filters.search).toLowerCase();
      refunds = refunds.filter((r) => {
        const name = (r.donor_id?.name || '').toLowerCase();
        const email = (r.donor_contact_email || '').toLowerCase();
        return name.includes(q) || email.includes(q);
      });
    }
    return refunds;
  }
}

