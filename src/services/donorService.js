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
import emailService, { buildEmailTemplate } from './emailService.js';

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

    // Email the donor with the public form link. Best-effort — refund is
    // already saved, so an email outage doesn't block the workflow.
    if (donorContactEmail) {
      sendDonorRefundFormEmail({
        to: donorContactEmail,
        donorName: donor.name || donor.primary_contact?.name || '',
        token,
        adminNotes: payload.admin_notes || ''
      }).catch((err) => {
        console.error('[donorService] refund email failed for', donorContactEmail, err?.message || err);
      });
    } else {
      console.warn('[donorService] no email on file for donor', donorId, '— refund created but donor was not notified');
    }

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

/**
 * Build + send the refund-initiation email to a donor. Caller fires this
 * fire-and-forget — failures are logged but never thrown so the underlying
 * refund record stays valid even if SMTP is down.
 */
async function sendDonorRefundFormEmail({ to, donorName, token, adminNotes }) {
  if (!to || !token) return;
  const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  const formUrl = `${baseUrl}/public/donors/refunds/${encodeURIComponent(token)}`;
  const greeting = donorName ? `Hi ${donorName},` : 'Hello,';

  const html = buildEmailTemplate({
    heading: 'Donation Refund Request',
    headingHighlight: 'Donation',
    bodyHtml: `
      <p style="margin: 0 0 14px 0; font-size: 14px; line-height: 1.6; color: #334155; text-align: center;">${greeting}</p>
      <p style="margin: 0 0 14px 0; font-size: 14px; line-height: 1.6; color: #334155; text-align: center;">A refund process has been initiated for one of your donations. To complete the refund we need a few details from you — original donation date, amount, payment method and a reason. The form takes about a minute.</p>
      ${adminNotes ? `<p style="margin: 0 0 14px 0; font-size: 13px; line-height: 1.6; color: #475569; text-align: center; background: #f8fafc; padding: 10px 14px; border-radius: 8px; border-left: 3px solid #0d9488;"><strong>Note from the team:</strong><br/>${escapeHtml(adminNotes)}</p>` : ''}
      <p style="margin: 0; font-size: 13px; line-height: 1.6; color: #334155; text-align: center;">Click the button below to fill in the secure form. The link is unique to you.</p>
    `,
    buttonText: 'Complete Refund Form',
    buttonLink: formUrl,
    infoBoxLines: [
      'This link is unique to you and should not be shared.',
      'You\'ll attach evidence of the original donation (receipt or statement).',
      'If you didn\'t expect this email, please reply to let us know.'
    ]
  });

  await emailService.sendEmail({
    to,
    subject: 'Action required — complete your donation refund form',
    html
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

