/**
 * Funding Agreement Controller
 *
 * HTTP handlers for funding agreements
 */

import { validationResult } from 'express-validator';
import { asyncHandler } from '../middleware/errorHandler.js';
import { FundingAgreementService } from '../services/fundingAgreementService.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { FundingAgreementRepository } from '../repositories/fundingAgreementRepository.js';
import { AppError } from '../middleware/errorHandler.js';

const parsePublicToken = (token, req) => {
  // Expected format: "<orgKey>.<token>"
  const raw = String(token || '').trim();
  const dotIdx = raw.indexOf('.');
  const prefix = dotIdx >= 0 ? raw.slice(0, dotIdx) : '';
  const rest = dotIdx >= 0 ? raw.slice(dotIdx + 1) : '';
  const orgKey = prefix || req?.headers?.['x-org-id'] || null;
  if (!orgKey || !rest) return null;
  return { orgKey, token: rest };
};

export const createAgreement = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const service = new FundingAgreementService(orgId);
  const agreement = await service.createAgreement({
    ...req.body,
    submitted_by: userId
  });

  res.status(201).json({
    success: true,
    data: agreement
  });
});

export const getAgreements = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    search: req.query.search
  };

  const service = new FundingAgreementService(orgId);
  const agreements = await service.getAgreements(filters);

  res.json({
    success: true,
    data: agreements
  });
});

export const getAgreementCounts = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new FundingAgreementService(orgId);
  const counts = await service.getAgreementCounts();

  res.json({
    success: true,
    data: counts
  });
});

export const getAgreementById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { agreementId } = req.params;

  const service = new FundingAgreementService(orgId);
  const agreement = await service.getAgreementById(agreementId);

  res.json({
    success: true,
    data: agreement
  });
});

export const signAgreementInternallyAndEmailPartner = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { agreementId } = req.params;
  const userId = req.user?.userId || req.userId || null;

  const service = new FundingAgreementService(orgId);
  const updated = await service.signAgreementInternallyAndEmailPartner(
    agreementId,
    {
      userId,
      first_name: req.user?.first_name,
      last_name: req.user?.last_name,
      name: req.user?.name
    },
    {
      signature_data: req.body.signature_data,
      notes: req.body.notes,
      partner_email: req.body.partner_email
    }
  );

  res.json({ success: true, data: updated });
});

export const getPublicAgreementForSigning = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const parsed = parsePublicToken(token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new FundingAgreementRepository(tenantDb);
  const agreement = await repo.findByPartnerSignToken(parsed.token);
  if (!agreement) throw new AppError('Agreement link not found', 404, 'NOT_FOUND');

  const now = new Date();
  if (agreement.partner_sign_token_expires_at && new Date(agreement.partner_sign_token_expires_at).getTime() < now.getTime()) {
    throw new AppError('This signing link has expired', 401, 'LINK_EXPIRED');
  }

  if (String(agreement.status) !== 'approved') {
    throw new AppError('This funding agreement is not approved', 400, 'AGREEMENT_NOT_APPROVED');
  }

  res.json({
    success: true,
    data: {
      _id: agreement._id,
      agreement_title: agreement.agreement_title,
      partner_name: agreement.partner_name,
      partner_email: agreement.partner_email,
      agreement_type: agreement.agreement_type,
      currency: agreement.currency,
      total_amount: agreement.total_amount,
      start_date: agreement.start_date,
      end_date: agreement.end_date,
      description: agreement.description,
      payment_terms: agreement.payment_terms,
      reporting_requirements: agreement.reporting_requirements,
      internal_signature: agreement.internal_signature,
      partner_signature: agreement.partner_signature,
      agreement_attachment_data_url: agreement.agreement_attachment_data_url,
      agreement_attachment_file_name: agreement.agreement_attachment_file_name,
      agreement_attachment_mime_type: agreement.agreement_attachment_mime_type
    }
  });
});

export const submitPartnerSignature = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const parsed = parsePublicToken(token, req);
  if (!parsed) throw new AppError('Invalid or missing token', 400, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(parsed.orgKey);
  const repo = new FundingAgreementRepository(tenantDb);
  const agreement = await repo.findByPartnerSignToken(parsed.token);
  if (!agreement) throw new AppError('Agreement link not found', 404, 'NOT_FOUND');

  const now = new Date();
  if (agreement.partner_sign_token_expires_at && new Date(agreement.partner_sign_token_expires_at).getTime() < now.getTime()) {
    throw new AppError('This signing link has expired', 401, 'LINK_EXPIRED');
  }

  if (String(agreement.status) !== 'approved') {
    throw new AppError('This funding agreement is not approved', 400, 'AGREEMENT_NOT_APPROVED');
  }

  if (!agreement?.internal_signature?.signed_at) {
    throw new AppError('This agreement is not ready for partner signature yet', 400, 'INTERNAL_SIGNATURE_REQUIRED');
  }

  if (agreement?.partner_signature?.signed_at) {
    throw new AppError('Funding agreement is already signed by partner', 409, 'AGREEMENT_ALREADY_SIGNED_PARTNER');
  }

  const signerName = String(req.body.signer_name || '').trim();
  const signerEmail = String(req.body.signer_email || agreement.partner_email || '').trim().toLowerCase();
  const signatureData = String(req.body.signature_data || '').trim();
  if (!signatureData) throw new AppError('Signature is required', 400, 'VALIDATION_ERROR');

  const updated = await repo.update(agreement._id, {
    partner_signature: {
      signed_at: new Date(),
      signer_name: signerName,
      signer_email: signerEmail,
      signature_data: signatureData
    },
    // Single-use token once partner has signed
    partner_sign_token: null,
    partner_sign_token_expires_at: null
  });

  res.json({ success: true, data: updated });
});
