/**
 * Donation Service
 * Handles creation of donations and triggering approval workflow.
 */

import { DonationRepository } from '../repositories/donationRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';

export class DonationService {
  constructor(orgId, tenantDb) {
    this.orgId = orgId;
    this.tenantDb = tenantDb;
    this.repo = new DonationRepository(tenantDb);
  }

  async createDonation(payload, submittedBy) {
    if (!payload?.title) {
      throw new AppError('Donation title is required', 400, 'VALIDATION_ERROR');
    }
    if (payload.amount == null) {
      throw new AppError('Donation amount is required', 400, 'VALIDATION_ERROR');
    }

    const donation = await this.repo.create({
      org_id: this.orgId,
      donor_id: payload.donor_id || null,
      title: payload.title,
      amount: payload.amount,
      currency: payload.currency || 'AUD',
      category: payload.category || null,
      submitted_at: payload.submitted_at || null,
      outcome_due_at: payload.outcome_due_at || null,
      lead_name: payload.lead_name || null,
      status: payload.status || 'draft',
      donor_snapshot: payload.donor_snapshot || null
    });

    // Trigger approval workflow using new "donation" action_type
    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      await workflowService.createDonationApprovalRequest(donation._id.toString(), submittedBy, donation.amount);
    } catch (err) {
      // Bubble up configuration errors (e.g. no workflow configured)
      console.error('Failed to create donation approval workflow:', {
        donationId: donation._id,
        amount: donation.amount,
        submittedBy,
        error: err.message,
        code: err.code
      });
      throw err;
    }

    return donation;
  }

  async listDonations(filters = {}) {
    return this.repo.findAll({
      org_id: this.orgId,
      status: filters.status,
      search: filters.search
    });
  }

  async getDonationById(donationId) {
    return this.repo.findById(donationId);
  }
}

