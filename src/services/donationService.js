/**
 * Donation Service
 * Handles creation of donations and triggering approval workflow.
 */

import { DonationRepository } from '../repositories/donationRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';
import { DonorRepository } from '../repositories/donorRepository.js';

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

    // Auto-set lead/applicant name from the current user unless explicitly provided
    let leadName = payload.lead_name || null;
    if (!leadName && submittedBy) {
      try {
        const { UserRepository } = await import('../repositories/userRepository.js');
        const userRepo = new UserRepository(this.tenantDb);
        const u = await userRepo.findById(submittedBy);
        const fn = u?.first_name || u?.firstName || '';
        const ln = u?.last_name || u?.lastName || '';
        const full = `${fn} ${ln}`.trim();
        leadName = full || u?.email || null;
      } catch {
        leadName = null;
      }
    }

    // If linking a donor, ensure it's approved and snapshot it so UI tables/workflows show correctly.
    let donorId = payload.donor_id || null;
    let donorSnapshot = payload.donor_snapshot || null;
    if (donorId) {
      const donorRepo = new DonorRepository(this.tenantDb);
      const donor = await donorRepo.findById(donorId);
      if (!donor) throw new AppError('Donor not found', 404, 'DONOR_NOT_FOUND');
      if (String(donor.org_id) !== String(this.orgId)) throw new AppError('Donor not found', 404, 'DONOR_NOT_FOUND');
      if (String(donor.status || '').toLowerCase() !== 'approved') {
        throw new AppError('Only approved donors can be selected for a donation', 400, 'DONOR_NOT_APPROVED');
      }
      donorSnapshot = {
        _id: donor._id,
        name: donor.name,
        donor_type: donor.donor_type,
        size: donor.size,
        abn_acn: donor.abn_acn,
        dgr_status: donor.dgr_status,
        primary_contact: donor.primary_contact || null,
      };
    }

    const donation = await this.repo.create({
      org_id: this.orgId,
      donor_id: donorId,
      title: payload.title,
      amount: payload.amount,
      currency: payload.currency || 'AUD',
      category: payload.category || null,
      submitted_at: payload.submitted_at || null,
      outcome_due_at: payload.outcome_due_at || null,
      lead_name: leadName,
      status: payload.status || 'draft',
      donor_snapshot: donorSnapshot
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

