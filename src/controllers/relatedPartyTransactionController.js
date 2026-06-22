/**
 * Related Party Transaction (RPT) Register controller.
 *
 * Standalone governance register. Risk is assessed against the org's Approval
 * Thresholds (see relatedPartyTransactionService.assessRisk). Records may be
 * created manually or from a COI declaration (payload `source.coi_request_id`).
 */

import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { logInfo } from '../utils/logger.js';
import { RelatedPartyTransactionRepository } from '../repositories/relatedPartyTransactionRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { assessRisk } from '../services/relatedPartyTransactionService.js';
import {
  RELATIONSHIP_TYPES,
  TRANSACTION_TYPES,
  RPT_STATUSES
} from '../db/schemas/platform/relatedPartyTransactionSchema.js';

// Resolve the Organization document _id (thresholds are keyed by it, not the
// tenant slug).
async function getOrgDocId(tenantDb) {
  const org = await new OrganizationRepository(tenantDb).findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  return org._id;
}

// Build the persisted fields from a request body + a fresh risk assessment.
async function buildRecordFields(tenantDb, orgDocId, body) {
  const relationship_type = RELATIONSHIP_TYPES.includes(body.relationship_type) ? body.relationship_type : 'other';
  const transaction_type = TRANSACTION_TYPES.includes(body.transaction_type) ? body.transaction_type : 'other';
  const transaction_value = body.transaction_value === '' || body.transaction_value == null
    ? null
    : Number(body.transaction_value);
  const competitive_quotes_obtained = !!body.competitive_quotes_obtained;

  const risk = await assessRisk(tenantDb, orgDocId, {
    relationshipType: relationship_type,
    transactionValue: transaction_value,
    competitiveQuotesObtained: competitive_quotes_obtained
  });

  return {
    related_party_name: String(body.related_party_name || '').trim(),
    relationship_type,
    related_person_name: body.related_person_name ? String(body.related_person_name).trim() : undefined,
    related_board_member_id: body.related_board_member_id || undefined,
    relationship_nature: body.relationship_nature ? String(body.relationship_nature).trim() : undefined,
    transaction_description: String(body.transaction_description || '').trim(),
    transaction_type,
    transaction_value,
    currency: body.currency ? String(body.currency).trim() : 'AUD',
    is_recurring: !!body.is_recurring,
    competitive_quotes_obtained,
    identification_date: body.identification_date ? new Date(body.identification_date) : undefined,
    transaction_date: body.transaction_date ? new Date(body.transaction_date) : undefined,
    conflicted_member_abstained: !!body.conflicted_member_abstained,
    notes: body.notes ? String(body.notes).trim() : undefined,
    ...risk
  };
}

export const listRpts = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);
  const { status, riskLevel, search } = req.query;
  const records = await repo.findByOrgId(orgDocId, { status, riskLevel, search });
  res.json({ success: true, data: records });
});

export const getRptCounts = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);
  const [byStatus, highRisk] = await Promise.all([
    repo.countByStatus(orgDocId),
    repo.countHighRisk(orgDocId)
  ]);
  res.json({ success: true, data: { ...byStatus, high_risk: highRisk } });
});

export const getRpt = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const record = await repo.findById(req.params.rptId);
  if (!record) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');
  res.json({ success: true, data: record });
});

export const createRpt = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);

  if (!String(req.body.related_party_name || '').trim()) {
    throw new AppError('Related party name is required', 400, 'VALIDATION_ERROR');
  }
  if (!String(req.body.transaction_description || '').trim()) {
    throw new AppError('Transaction description is required', 400, 'VALIDATION_ERROR');
  }

  const fields = await buildRecordFields(req.tenantDb, orgDocId, req.body);

  // Provenance: manual unless a COI is supplied.
  const source = req.body.source?.coi_request_id
    ? { type: 'coi', coi_request_id: req.body.source.coi_request_id }
    : { type: 'manual' };

  // De-dupe: one RPT per COI. If this COI already spawned an RPT, return it.
  if (source.type === 'coi') {
    const existing = await repo.findByCoi(orgDocId, source.coi_request_id);
    if (existing) return res.status(200).json({ success: true, data: existing, message: 'Linked to existing RPT' });
  }

  const rpt_number = req.body.rpt_number
    || await repo.nextRptNumber(orgDocId, new Date().getFullYear());

  const created = await repo.create({
    org_id: orgDocId,
    rpt_number,
    ...fields,
    source,
    status: 'identified',
    created_by: req.user.userId,
    updated_by: req.user.userId
  });

  logInfo('Related party transaction created', { rptId: created._id, source: source.type, orgId: req.orgId });
  res.status(201).json({ success: true, data: created });
});

export const updateRpt = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);
  const existing = await repo.findByIdMutable(req.params.rptId);
  if (!existing) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');

  // Merge so risk re-assessment uses the latest values (body may be partial).
  const merged = {
    relationship_type: req.body.relationship_type ?? existing.relationship_type,
    transaction_value: req.body.transaction_value ?? existing.transaction_value,
    competitive_quotes_obtained: req.body.competitive_quotes_obtained ?? existing.competitive_quotes_obtained,
    related_party_name: req.body.related_party_name ?? existing.related_party_name,
    transaction_description: req.body.transaction_description ?? existing.transaction_description,
    related_person_name: req.body.related_person_name ?? existing.related_person_name,
    related_board_member_id: req.body.related_board_member_id ?? existing.related_board_member_id,
    relationship_nature: req.body.relationship_nature ?? existing.relationship_nature,
    transaction_type: req.body.transaction_type ?? existing.transaction_type,
    currency: req.body.currency ?? existing.currency,
    is_recurring: req.body.is_recurring ?? existing.is_recurring,
    identification_date: req.body.identification_date ?? existing.identification_date,
    transaction_date: req.body.transaction_date ?? existing.transaction_date,
    conflicted_member_abstained: req.body.conflicted_member_abstained ?? existing.conflicted_member_abstained,
    notes: req.body.notes ?? existing.notes
  };

  const fields = await buildRecordFields(req.tenantDb, orgDocId, merged);
  const updated = await repo.update(req.params.rptId, { ...fields, updated_by: req.user.userId });
  res.json({ success: true, data: updated });
});

// Record the board's decision on the transaction (approval + abstention).
export const recordBoardDecision = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const existing = await repo.findByIdMutable(req.params.rptId);
  if (!existing) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');

  const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
  const patch = {
    status: decision,
    conflicted_member_abstained: req.body.conflicted_member_abstained ?? existing.conflicted_member_abstained,
    board_approval: {
      approved: decision === 'approved',
      approval_date: req.body.approval_date ? new Date(req.body.approval_date) : new Date(),
      reference: req.body.reference ? String(req.body.reference).trim() : '',
      minute_reference: req.body.minute_reference ? String(req.body.minute_reference).trim() : '',
      approved_by: req.user.userId
    },
    updated_by: req.user.userId
  };
  const updated = await repo.update(req.params.rptId, patch);
  res.json({ success: true, data: updated });
});

// Lightweight status transitions (e.g. under_review, disclosed).
export const updateRptStatus = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const existing = await repo.findByIdMutable(req.params.rptId);
  if (!existing) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');
  const status = req.body.status;
  if (!RPT_STATUSES.includes(status)) throw new AppError('Invalid status', 400, 'VALIDATION_ERROR');

  const patch = { status, updated_by: req.user.userId };
  if (status === 'disclosed') {
    patch.disclosure = {
      disclosed: true,
      financial_year: req.body.financial_year ? String(req.body.financial_year).trim() : existing.disclosure?.financial_year,
      disclosed_at: new Date()
    };
  }
  const updated = await repo.update(req.params.rptId, patch);
  res.json({ success: true, data: updated });
});

export const addRptDocument = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const existing = await repo.findByIdMutable(req.params.rptId);
  if (!existing) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');
  const { file_key, file_name, mime_type, size } = req.body;
  if (!file_key) throw new AppError('file_key is required', 400, 'VALIDATION_ERROR');
  existing.supporting_documents.push({ file_key, file_name, mime_type, size, uploaded_by: req.user.userId, uploaded_at: new Date() });
  existing.updated_by = req.user.userId;
  await existing.save();
  const fresh = await repo.findById(req.params.rptId);
  res.json({ success: true, data: fresh });
});

export const deleteRpt = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const existing = await repo.findByIdMutable(req.params.rptId);
  if (!existing) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');
  await repo.update(req.params.rptId, { is_active: false, updated_by: req.user.userId });
  res.json({ success: true, message: 'Related party transaction archived' });
});

// Lookup an RPT for a given COI (used by the COI detail page to show linkage).
export const getRptByCoi = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);
  const record = await repo.findByCoi(orgDocId, req.params.coiRequestId);
  res.json({ success: true, data: record || null });
});
