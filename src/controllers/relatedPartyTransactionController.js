/**
 * Related Party Transaction (RPT) Register controller.
 *
 * Standalone governance register. Risk is assessed against the org's Approval
 * Thresholds (see relatedPartyTransactionService.assessRisk). Records may be
 * created manually or from a COI declaration (payload `source.coi_request_id`).
 */

import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';
import { RelatedPartyTransactionRepository } from '../repositories/relatedPartyTransactionRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { assessRisk } from '../services/relatedPartyTransactionService.js';
import { detectRptFromText } from '../services/rptDetectionService.js';
import { ApprovalWorkflowService } from '../services/approvalWorkflowService.js';
import coiRequestSchema from '../db/schemas/platform/coiRequestSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
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

  // An RPT MUST run through its own approval workflow (final approver = a board
  // member, enforced at matrix creation). If no workflow is configured we HARD
  // STOP: roll back the just-created RPT and surface the error so the frontend
  // opens the workflow-setup guard. If it came from a COI, HALT that COI until
  // the RPT is resolved.
  let workflow = null;
  try {
    const wf = new ApprovalWorkflowService(req.orgId);
    const apprReq = await wf.createRptApprovalRequest(created._id, req.user.userId);
    workflow = { approval_request_id: apprReq?._id, status: 'pending' };

    if (source.type === 'coi' && source.coi_request_id && apprReq?._id) {
      const CoiRequest = req.tenantDb.models.CoiRequest || req.tenantDb.model('CoiRequest', coiRequestSchema);
      const coi = await CoiRequest.findById(source.coi_request_id);
      if (coi && ['pending'].includes(coi.status)) {
        coi.status = 'paused_for_rpt';
        coi.current_rpt_request_id = created._id;
        await coi.save();
        logInfo('COI halted pending RPT approval', { coiId: coi._id, rptId: created._id });
      }
    }
  } catch (wfErr) {
    // Roll back the orphan RPT — it can't exist without a workflow to govern it.
    await repo.hardDelete(created._id).catch((delErr) =>
      logError('Failed to roll back RPT after workflow error', { rptId: created._id, error: delErr?.message }));

    if (['WORKFLOW_NOT_CONFIGURED', 'NO_MATCHING_RULE', 'NO_APPROVERS_FOUND'].includes(wfErr?.code)) {
      logInfo('RPT creation blocked — no RPT workflow configured', { code: wfErr.code, orgId: req.orgId });
      throw new AppError(
        wfErr.message || 'An approval workflow must be configured for Related Party Transactions before one can be created.',
        400,
        wfErr.code,
        wfErr.details
      );
    }
    logError('RPT workflow trigger failed', { error: wfErr?.message, code: wfErr?.code });
    throw new AppError(
      'Could not start the approval workflow for this related party transaction. No record was created.',
      500,
      'RPT_WORKFLOW_FAILED'
    );
  }

  const fresh = await repo.findById(created._id);
  res.status(201).json({ success: true, data: fresh || created, workflow });
});

/**
 * Called from the approval engine when an RPT's workflow is fully approved
 * (its final board-member step signed off). Marks the RPT approved and resumes
 * any COI that was halted for it. Best-effort; never throws to the engine.
 */
export async function finalizeRptFromApprovalRequest(tenantDb, rptId, userId) {
  const repo = new RelatedPartyTransactionRepository(tenantDb);
  const rpt = await repo.findByIdMutable(rptId);
  if (!rpt) return;

  await repo.update(rptId, {
    status: 'approved',
    board_approval: {
      approved: true,
      approval_date: new Date(),
      reference: 'Approved via RPT workflow',
      approved_by: userId,
    },
    updated_by: userId,
  });

  await resumeLinkedCoi(tenantDb, rpt);
}

// Resume a COI that was halted (paused_for_rpt) for this RPT, once the RPT is
// resolved (approved). No-op if there's no linked COI or it isn't halted. Also
// clears the "unresolved RPT" halt tag on the COI and its parent workflow.
async function resumeLinkedCoi(tenantDb, rpt) {
  const coiId = rpt.source?.coi_request_id;
  if (!coiId) return;
  try {
    const CoiRequest = tenantDb.models.CoiRequest || tenantDb.model('CoiRequest', coiRequestSchema);
    const coi = await CoiRequest.findById(coiId);
    if (coi && coi.status === 'paused_for_rpt') {
      coi.status = 'pending';
      coi.current_rpt_request_id = null;
      coi.rpt_unresolved = false;
      await coi.save();
      await tagParentWorkflowRptUnresolved(tenantDb, coi.parent_approval_request_id, false);
      logInfo('COI resumed after RPT approval', { coiId, rptId: rpt._id });
    }
  } catch (err) {
    logError('Failed to resume COI after RPT approval', { coiId, rptId: rpt._id, error: err?.message });
  }
}

// Flag the COI (which stays paused_for_rpt) and its parent workflow as halted
// because their related party transaction was left UNRESOLVED (declined). The
// flag drives the "halted — unresolved RPT" status label across the app.
async function haltLinkedCoiForUnresolvedRpt(tenantDb, rpt) {
  const coiId = rpt.source?.coi_request_id;
  if (!coiId) return;
  try {
    const CoiRequest = tenantDb.models.CoiRequest || tenantDb.model('CoiRequest', coiRequestSchema);
    const coi = await CoiRequest.findById(coiId);
    if (coi && coi.status === 'paused_for_rpt') {
      coi.rpt_unresolved = true;
      await coi.save();
      await tagParentWorkflowRptUnresolved(tenantDb, coi.parent_approval_request_id, true);
      logInfo('COI halted — linked RPT left unresolved', { coiId, rptId: rpt._id });
    }
  } catch (err) {
    logError('Failed to tag COI as halted for unresolved RPT', { coiId, rptId: rpt._id, error: err?.message });
  }
}

// Set/clear the rpt_unresolved tag on the workflow that originally triggered the
// COI (paused_for_coi), so it surfaces the same "halted — unresolved RPT" state.
async function tagParentWorkflowRptUnresolved(tenantDb, parentApprovalRequestId, unresolved) {
  if (!parentApprovalRequestId) return;
  try {
    const ApprovalRequest = tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
    const parent = await ApprovalRequest.findById(parentApprovalRequestId);
    if (parent && parent.status === 'paused_for_coi') {
      parent.rpt_unresolved = unresolved;
      await parent.save();
    }
  } catch (err) {
    logError('Failed to tag parent workflow for unresolved RPT', { parentApprovalRequestId, error: err?.message });
  }
}

/**
 * Called from the approval engine when an RPT's workflow is REJECTED (the board
 * decided the transaction is not acceptable / unresolved). Marks the RPT
 * rejected and KEEPS any linked COI halted (paused_for_rpt) — the COI cannot
 * proceed while its related party transaction is unresolved. Best-effort.
 */
export async function finalizeRptRejectionFromApprovalRequest(tenantDb, rptId, userId) {
  const repo = new RelatedPartyTransactionRepository(tenantDb);
  const rpt = await repo.findByIdMutable(rptId);
  if (!rpt) return;

  await repo.update(rptId, {
    status: 'rejected',
    board_approval: {
      approved: false,
      approval_date: new Date(),
      reference: 'Rejected via RPT workflow',
      approved_by: userId,
    },
    updated_by: userId,
  });

  // Intentionally do NOT resume the COI — an unresolved RPT keeps it halted.
  // Tag the COI and its parent workflow so they read as "halted — unresolved RPT".
  await haltLinkedCoiForUnresolvedRpt(tenantDb, rpt);
}

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

// Link an EXISTING RPT to a COI declaration (the "link to existing" counterpart
// of create-from-COI). Stamps the RPT's provenance so the COI panel — which
// resolves the link via RPT.source.coi_request_id — sees it, and couples the
// COI's paused/resolved state to the RPT's current status, exactly like the
// create path does. The RPT's own approval workflow already exists, so we do
// NOT re-create or re-trigger it.
export const linkRptToCoi = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);
  const { rptId } = req.params;
  const coiRequestId = req.body.coi_request_id;
  if (!coiRequestId) throw new AppError('coi_request_id is required', 400, 'VALIDATION_ERROR');

  const rpt = await repo.findByIdMutable(rptId);
  if (!rpt) throw new AppError('Related party transaction not found', 404, 'RPT_NOT_FOUND');

  // Already linked to a COI? Idempotent if it's the same one; reject if different.
  if (rpt.source?.type === 'coi' && rpt.source?.coi_request_id) {
    if (String(rpt.source.coi_request_id) === String(coiRequestId)) {
      return res.json({ success: true, data: await repo.findById(rptId), message: 'Already linked to this declaration' });
    }
    throw new AppError('This related party transaction is already linked to another declaration.', 409, 'RPT_ALREADY_LINKED');
  }

  // One RPT per COI — don't attach a second.
  const existingForCoi = await repo.findByCoi(orgDocId, coiRequestId);
  if (existingForCoi && String(existingForCoi._id) !== String(rptId)) {
    throw new AppError('This declaration is already linked to a related party transaction.', 409, 'COI_ALREADY_LINKED');
  }

  const CoiRequest = req.tenantDb.models.CoiRequest || req.tenantDb.model('CoiRequest', coiRequestSchema);
  const coi = await CoiRequest.findById(coiRequestId);
  if (!coi) throw new AppError('Conflict of interest declaration not found', 404, 'COI_NOT_FOUND');

  // Stamp provenance (the COI panel resolves the link off this).
  await repo.update(rptId, { source: { type: 'coi', coi_request_id: coiRequestId }, updated_by: req.user.userId });

  // Couple the COI to the RPT's current state, mirroring create + resume/halt.
  const status = String(rpt.status || '').toLowerCase();
  if (status === 'rejected') {
    if (coi.status === 'pending') coi.status = 'paused_for_rpt';
    coi.current_rpt_request_id = rpt._id;
    coi.rpt_unresolved = true;
  } else if (['approved', 'disclosed'].includes(status)) {
    // Already resolved — link for the audit trail but don't hold the COI up.
    if (coi.status === 'paused_for_rpt') coi.status = 'pending';
    coi.current_rpt_request_id = null;
    coi.rpt_unresolved = false;
  } else {
    // identified / under_review — halt the COI until the RPT is approved.
    if (coi.status === 'pending') coi.status = 'paused_for_rpt';
    coi.current_rpt_request_id = rpt._id;
    coi.rpt_unresolved = false;
  }
  await coi.save();

  logInfo('RPT linked to COI', { rptId, coiId: coiRequestId, rptStatus: status, orgId: req.orgId });
  res.json({ success: true, data: await repo.findById(rptId), message: 'Linked to declaration' });
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

  // Keep the linked COI consistent with the manual decision: resume it when the
  // RPT is approved (resolved); leave it halted when rejected (unresolved).
  if (decision === 'approved') {
    await resumeLinkedCoi(req.tenantDb, existing);
  } else {
    await haltLinkedCoiForUnresolvedRpt(req.tenantDb, existing);
  }

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

// AI/keyword detection — does this COI declaration look like a Related Party
// Transaction? Returns { isLikely, confidence, keywords, reason, relationshipType,
// transactionType }. Advisory only; never persists.
export const detectRpt = asyncHandler(async (req, res) => {
  const result = await detectRptFromText({
    reason: req.body.reason,
    personName: req.body.personName,
    personDetails: req.body.personDetails,
  });
  res.json({ success: true, data: result });
});

// Live risk preview — scores a would-be transaction WITHOUT persisting it, so the
// create/attach form can show the risk score as the user fills it in. Same engine
// as create/update (value scored against the org's approval thresholds).
export const previewRptRisk = asyncHandler(async (req, res) => {
  const orgDocId = await getOrgDocId(req.tenantDb);
  const relationship_type = RELATIONSHIP_TYPES.includes(req.body.relationship_type) ? req.body.relationship_type : 'other';
  const transaction_value = req.body.transaction_value === '' || req.body.transaction_value == null
    ? null
    : Number(req.body.transaction_value);
  const risk = await assessRisk(req.tenantDb, orgDocId, {
    relationshipType: relationship_type,
    transactionValue: transaction_value,
    competitiveQuotesObtained: !!req.body.competitive_quotes_obtained
  });
  res.json({ success: true, data: risk });
});

// Lookup an RPT for a given COI (used by the COI detail page to show linkage).
export const getRptByCoi = asyncHandler(async (req, res) => {
  const repo = new RelatedPartyTransactionRepository(req.tenantDb);
  const orgDocId = await getOrgDocId(req.tenantDb);
  const record = await repo.findByCoi(orgDocId, req.params.coiRequestId);
  res.json({ success: true, data: record || null });
});
