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
   * Manually record a donor refund — bookkeeping entry for a donor not
   * in the system. Skips the public donor form but DOES trigger the
   * standard refunds approval workflow so the refund is on the audit
   * trail with the right sign-offs.
   *
   * Flow:
   *   1. Validate fields
   *   2. Resolve the refunds approval matrix + approvers
   *      - if no matrix configured: WORKFLOW_NOT_CONFIGURED (frontend
   *        opens the global guard dialog as it does for other modules)
   *   3. Save refund row with status 'awaiting_internal_approval'
   *   4. Create ApprovalRequest pointing back at this refund
   *   5. Link refund.internal_approval_request_id → approval
   *   6. (Approval engine completion handler) when approvers sign off,
   *      flip refund.status → 'completed'. That's handled in
   *      approvalWorkflowService.
   *
   * @param {string} userId — who's recording the entry
   * @param {object} payload — manual_* fields (see frontend form)
   */
  async createManualDonorRefund(userId, payload = {}) {
    if (!payload?.manual_donor_name?.trim()) {
      throw new AppError('Donor name is required for manual refunds', 400, 'VALIDATION_ERROR');
    }
    const amt = Number(payload.manual_refund_amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new AppError('Refund amount must be a positive number', 400, 'VALIDATION_ERROR');
    }

    // Look up the refunds workflow matrix (workflow_category 'refunds_approval'
    // OR a rule with action_type 'refunds'). Same belt-and-braces lookup we
    // use for supplier vetting.
    const { ApprovalMatrixRepository } = await import('../repositories/approvalMatrixRepository.js');
    const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
    const orgRepo = new OrganizationRepository(this.tenantDb);
    const org = await orgRepo.findOne();
    if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    const matrixRepo = new ApprovalMatrixRepository(this.tenantDb);
    const matrices = await matrixRepo.findByOrgId(org._id);
    const matrix = (matrices || []).find((m) => {
      if (m.is_active === false) return false;
      if (m.workflow_category === 'refunds_approval' || m.workflow_category === 'refunds') return true;
      const rules = m.rules || m.approval_rules || [];
      return rules.some((r) => r.action_type === 'refunds' && r.is_active !== false);
    });
    if (!matrix) {
      throw new AppError(
        'No active Refunds workflow is configured. Configure one in Role Permissions → Approval Workflows.',
        400,
        'WORKFLOW_NOT_CONFIGURED'
      );
    }

    // Resolve the approver list using the same helper supplier vetting uses.
    const { CoiWorkflowService } = await import('./coiWorkflowService.js');
    const workflowService = new CoiWorkflowService(this.orgId);
    const rule = matrix.rules?.[0] || matrix.approval_rules?.[0] || matrix;
    const approvers = await workflowService.resolveApprovers(
      matrix.rules ? { approval_rules: [rule] } : matrix,
      org._id
    );
    if (!approvers || approvers.length === 0) {
      throw new AppError(
        'Refunds workflow has no approvers configured.',
        400,
        'NO_APPROVERS'
      );
    }

    const refundRepo = new DonorRefundRepository(this.tenantDb);
    const now = new Date();
    const refund = await refundRepo.create({
      org_key: this.orgId,
      org_id: this.orgId,
      source: 'manual',
      status: 'awaiting_internal_approval',
      initiated_at: now,
      initiated_by: userId,
      donor_contact_email: payload.manual_donor_email?.trim() || '',
      admin_notes: payload.admin_notes || '',
      manual_donor_name:     payload.manual_donor_name.trim(),
      manual_donor_email:    payload.manual_donor_email?.trim() || '',
      manual_receipt_number: payload.manual_receipt_number?.trim() || '',
      manual_refund_amount:  amt,
      manual_refund_date:    payload.manual_refund_date || '',
      manual_payment_method: payload.manual_payment_method?.trim() || '',
      manual_reason:         payload.manual_reason?.trim() || '',
      manual_attachments:    Array.isArray(payload.manual_attachments) ? payload.manual_attachments : []
    });

    // Create the approval request now that we have the refund's _id.
    // entity_type: 'other' because donor refund isn't its own entity_type
    // in the ApprovalRequest enum; the engine correlates back to this
    // row via the internal_approval_request_id we set below.
    const { ApprovalRequestRepository } = await import('../repositories/approvalRequestRepository.js');
    const approvalRepo = new ApprovalRequestRepository(this.tenantDb);
    const approvalSteps = approvers.map((a) => ({
      level: a.level,
      approver_user_id: a.user_id,
      approver_position_id: a.position_id,
      approver_department_id: a.department_id,
      status: 'pending'
    }));
    const approvalRequest = await approvalRepo.create({
      org_id: org._id,
      request_type: 'refunds',
      entity_id: refund._id,
      entity_type: 'other',
      amount: amt,
      workflow_category: 'refunds_approval',
      approval_matrix_id: matrix._id,
      approval_type: matrix.approval_type || 'sequential',
      approval_steps: approvalSteps,
      submitted_by: userId,
      status: 'pending',
      title: `Donor refund — ${payload.manual_donor_name.trim()}`,
      description: `Manual donor refund · $${amt.toFixed(2)}${payload.manual_reason ? ` · ${payload.manual_reason}` : ''}`
    });

    // Link the refund back to the approval request so the engine can
    // flip status when sign-offs complete.
    await refundRepo.updateById(refund._id, { internal_approval_request_id: approvalRequest._id });
    return { ...refund.toObject(), internal_approval_request_id: approvalRequest._id };
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

