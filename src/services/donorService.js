/**
 * Donor Service
 *
 * Business logic for donor management.
 */

import { DonorRepository } from '../repositories/donorRepository.js';
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
}

