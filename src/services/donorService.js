/**
 * Donor Service
 *
 * Business logic for donor management and refund workflows.
 */

import crypto from 'crypto';
import { DonorRepository } from '../repositories/donorRepository.js';
import { DonorRefundRepository } from '../repositories/donorRefundRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';
import { getRouterConnection } from '../config/database.js';
import emailService from './emailService.js';
import { logError, logInfo } from '../utils/logger.js';

const REFUND_TOKEN_LOOKUP_COL = 'donor_refund_token_lookup';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export class DonorService {
  constructor(orgId, tenantDb) {
    this.orgId = orgId;
    this.tenantDb = tenantDb;
    this.repo = new DonorRepository(tenantDb);
    this.refundRepo = new DonorRefundRepository(tenantDb);
  }

  async createDonor(payload, submittedBy) {
    if (!payload?.name) {
      throw new AppError('Donor name is required', 400, 'VALIDATION_ERROR');
    }

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

    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      await workflowService.createDonorApprovalRequest(donor._id.toString(), submittedBy);
    } catch (err) {
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

  // ── Refund methods ──────────────────────────────────────────────────

  async initiateDonorRefund(donorId, userId, body = {}) {
    const donor = await this.repo.findById(donorId);
    if (!donor || String(donor.org_id) !== String(this.orgId)) {
      throw new AppError('Donor not found', 404, 'NOT_FOUND');
    }

    const existing = await this.refundRepo.findActiveByDonorId(donorId);
    if (existing) {
      throw new AppError('An active refund request already exists for this donor', 400, 'REFUND_ALREADY_ACTIVE');
    }

    const token = crypto.randomBytes(32).toString('hex');
    const donorEmail = donor.primary_contact?.email || '';

    const refund = await this.refundRepo.create({
      org_key: this.orgId,
      org_id: this.orgId,
      donor_id: donorId,
      token,
      status: 'awaiting_donor_form',
      initiated_at: new Date(),
      initiated_by: userId || null,
      donor_contact_email: donorEmail,
      admin_notes: body.admin_notes || '',
    });

    await this._registerRefundTokenLookup(token, null);

    if (donorEmail) {
      const formLink = `${FRONTEND_URL}/public/donors/refunds/${token}`;
      try {
        await emailService.sendProjectRefundExternalFormEmail({
          to: donorEmail,
          recipientName: donor.primary_contact?.name || donor.name || 'Donor',
          projectName: donor.name,
          refundAmount: null,
          formLink,
        });
        logInfo('Donor refund form email sent', { donorId, refundId: refund._id });
      } catch (err) {
        logError('Failed to send donor refund form email', err, { donorId });
      }
    }

    return refund;
  }

  async listDonorRefunds(filters = {}) {
    return this.refundRepo.findByOrgKey(this.orgId, filters.donorId || null);
  }

  async submitPublicRefundForm(token, body) {
    const refund = await this.refundRepo.findByToken(token, this.orgId);
    if (!refund) {
      throw new AppError('Invalid or expired refund link', 404, 'REFUND_NOT_FOUND');
    }
    if (refund.status !== 'awaiting_donor_form') {
      throw new AppError('This refund form has already been submitted', 400, 'ALREADY_SUBMITTED');
    }

    const updated = await this.refundRepo.updateById(refund._id, {
      status: 'donor_form_submitted',
      donor_submission: {
        submitted_at: new Date(),
        donation_date: body.donation_date || '',
        donation_amount: Number(body.donation_amount) || 0,
        payment_method: body.payment_method || '',
        reason: body.reason || '',
        notes: body.notes || '',
        evidence: Array.isArray(body.evidence) ? body.evidence : [],
      },
    });

    return updated;
  }

  async initiateDonorRefundWorkflow(refundId, body = {}) {
    const refund = await this.refundRepo.findById(refundId);
    if (!refund) {
      throw new AppError('Refund not found', 404, 'REFUND_NOT_FOUND');
    }

    if (!['donor_form_submitted', 'pending_initiation'].includes(refund.status)) {
      throw new AppError('Refund is not in a state that allows workflow initiation', 400, 'INVALID_STATE');
    }

    return refund;
  }

  async startDonorRefundProcessing(refundId) {
    const refund = await this.refundRepo.findById(refundId);
    if (!refund) throw new AppError('Refund not found', 404, 'NOT_FOUND');

    if (!['donor_form_submitted', 'internal_approved'].includes(refund.status)) {
      throw new AppError('Refund cannot be processed in its current state', 400, 'INVALID_STATE');
    }

    return this.refundRepo.updateById(refundId, {
      status: 'refund_processing',
      processing_started_at: new Date(),
    });
  }

  async recordDonorRefundPaymentSent(refundId, body = {}) {
    const refund = await this.refundRepo.findById(refundId);
    if (!refund) throw new AppError('Refund not found', 404, 'NOT_FOUND');

    if (refund.status !== 'refund_processing') {
      throw new AppError('Refund is not in processing state', 400, 'INVALID_STATE');
    }

    const paymentAckToken = crypto.randomBytes(32).toString('hex');
    await this._registerRefundTokenLookup(null, paymentAckToken);

    const updated = await this.refundRepo.updateById(refundId, {
      status: 'awaiting_donor_acknowledgment',
      refund_payment_sent_at: new Date(),
      payment_reference: body.payment_reference || '',
      payment_proof: Array.isArray(body.payment_proof) ? body.payment_proof : [],
      payment_notification: {
        message_for_donor: body.message_for_donor || '',
        amount_paid: Number(body.amount_paid) || 0,
        payment_method_used: body.payment_method_used || '',
        sent_at: new Date(),
      },
      payment_ack_token: paymentAckToken,
    });

    const donorEmail = refund.donor_contact_email || refund.donor_id?.primary_contact?.email;
    if (donorEmail) {
      const ackLink = `${FRONTEND_URL}/public/donors/refunds/payment-ack/${paymentAckToken}`;
      try {
        await emailService.sendProjectRefundExternalFormEmail({
          to: donorEmail,
          recipientName: refund.donor_id?.name || 'Donor',
          projectName: refund.donor_id?.name || 'Refund',
          refundAmount: body.amount_paid ? String(body.amount_paid) : null,
          formLink: ackLink,
        });
      } catch (err) {
        logError('Failed to send donor payment ack email', err, { refundId });
      }
    }

    return updated;
  }

  async getDonorRefundPaymentAckContext(ackToken) {
    const refund = await this.refundRepo.findByPaymentAckToken(ackToken, this.orgId);
    if (!refund) throw new AppError('Invalid or expired acknowledgement link', 404, 'REFUND_NOT_FOUND');

    return {
      donorName: refund.donor_id?.name || '',
      amountPaid: refund.payment_notification?.amount_paid || 0,
      paymentMethod: refund.payment_notification?.payment_method_used || '',
      messageFromOrg: refund.payment_notification?.message_for_donor || '',
      paymentDate: refund.refund_payment_sent_at || null,
      status: refund.status,
    };
  }

  async submitDonorRefundPaymentAck(ackToken, body) {
    const refund = await this.refundRepo.findByPaymentAckToken(ackToken, this.orgId);
    if (!refund) throw new AppError('Invalid or expired acknowledgement link', 404, 'REFUND_NOT_FOUND');

    if (refund.status !== 'awaiting_donor_acknowledgment') {
      throw new AppError('This acknowledgement has already been submitted', 400, 'ALREADY_SUBMITTED');
    }

    return this.refundRepo.updateById(refund._id, {
      status: 'donor_acknowledged',
      donor_payment_acknowledgment: {
        submitted_at: new Date(),
        signer_name: body.signer_name || '',
        confirm_received: !!body.confirm_received,
        notes: body.notes || '',
      },
    });
  }

  async completeDonorRefundProcessing(refundId) {
    const refund = await this.refundRepo.findById(refundId);
    if (!refund) throw new AppError('Refund not found', 404, 'NOT_FOUND');

    return this.refundRepo.updateById(refundId, {
      status: 'completed',
      completed_at: new Date(),
      completion_notes: refund.completion_notes || '',
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────

  async _registerRefundTokenLookup(token, paymentAckToken) {
    try {
      const routerDb = getRouterConnection();
      const col = routerDb.collection(REFUND_TOKEN_LOOKUP_COL);
      const update = { orgId: this.orgId, updatedAt: new Date() };
      if (token) {
        await col.updateOne({ token }, { $set: { token, ...update } }, { upsert: true });
      }
      if (paymentAckToken) {
        await col.updateOne({ payment_ack_token: paymentAckToken }, { $set: { payment_ack_token: paymentAckToken, ...update } }, { upsert: true });
      }
    } catch (err) {
      logError('Failed to register donor refund token lookup', err);
    }
  }
}

