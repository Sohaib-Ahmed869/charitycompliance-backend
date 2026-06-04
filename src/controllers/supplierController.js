/**
 * Supplier Controller
 *
 * Surfaces the Supplier Register CRUD + workflow lifecycle. Mounted at
 * /api/v1/platform/suppliers in app.js. Every authenticated route uses
 * the per-request tenant connection from req.tenantDb.
 *
 * Workflow lifecycle (mirrors COI / partner vetting):
 *   - createSupplier:   draft status, no workflow yet
 *   - submitForVetting: resolves the org's `supplier_vetting` matrix +
 *                       creates an ApprovalRequest, flips status to
 *                       `pending_review`, points supplier.approval_request_id
 *                       at the new request
 *   - finalizeFromApproval: called by the approval engine when the request
 *                           settles. Flips supplier.vetting_status to
 *                           approved / rejected and stamps the audit fields.
 */

import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { SupplierRepository } from '../repositories/supplierRepository.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { CoiWorkflowService } from '../services/coiWorkflowService.js';
import { runBulkImport } from '../services/bulkImportService.js';
import { supplierImporter } from '../services/importers/supplierImporter.js';
import { logInfo, logError } from '../utils/logger.js';

const orgObjectIdFromTenant = async (tenantDb) => {
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  return org._id;
};

// ─── LIST ──────────────────────────────────────────────────────────────
export const listSuppliers = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const orgId = await orgObjectIdFromTenant(req.tenantDb);
  const { vetting_status, category, is_active, search } = req.query;
  const filters = {
    vetting_status,
    category,
    search,
    is_active: typeof is_active === 'string' ? is_active === 'true' : undefined
  };
  const suppliers = await repo.findByOrgId(orgId, filters);
  res.json({ success: true, data: suppliers });
});

// ─── COUNTS (KpiStrip) ─────────────────────────────────────────────────
export const getSupplierCounts = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const orgId = await orgObjectIdFromTenant(req.tenantDb);
  const counts = await repo.getCountsByOrg(orgId);
  res.json({ success: true, data: counts });
});

// ─── DROPDOWN (expense form) ───────────────────────────────────────────
// Compact projection. Only approved + active + not-expired records.
// No bank details. ABN reduced to last-4 for display.
export const getSupplierDropdown = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const orgId = await orgObjectIdFromTenant(req.tenantDb);
  const list = await repo.findForDropdown(orgId);
  res.json({ success: true, data: list });
});

// ─── DETAIL ────────────────────────────────────────────────────────────
export const getSupplierById = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const supplier = await repo.findByIdWithWorkflow(req.params.supplierId);
  if (!supplier) throw new AppError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');
  res.json({ success: true, data: supplier });
});

// ─── CREATE ────────────────────────────────────────────────────────────
export const createSupplier = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const orgId = await orgObjectIdFromTenant(req.tenantDb);

  // Auto-generate the supplier number when caller didn't supply one.
  const supplier_number = req.body.supplier_number
    || await repo.nextSupplierNumber(orgId);

  const supplier = await repo.create({
    ...req.body,
    supplier_number,
    org_id: orgId,
    vetting_status: 'draft',
    created_by: req.user.userId,
    updated_by: req.user.userId
  });
  logInfo('Supplier created', { supplierId: supplier._id, orgId });
  res.status(201).json({ success: true, data: supplier });
});

// ─── BULK IMPORT ───────────────────────────────────────────────────────
// Each row → a draft supplier → submitted into the supplier_vetting
// workflow. Dedupes on ABN / contact email / legal name. A missing
// workflow config does not fail the import (suppliers land as draft and
// the response flags `approval.configured: false`).
export const bulkImportSuppliers = asyncHandler(async (req, res) => {
  const result = await runBulkImport({
    tenantDb: req.tenantDb,
    orgId: req.orgId,
    actor: { userId: req.user.userId },
    rows: Array.isArray(req.body?.rows) ? req.body.rows : [],
    importer: supplierImporter
  });
  res.status(207).json({ success: true, data: result });
});

// ─── UPDATE ────────────────────────────────────────────────────────────
export const updateSupplier = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const existing = await repo.findById(req.params.supplierId);
  if (!existing) throw new AppError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');

  // Material-change detection: if bank details change on an approved
  // supplier, force a re-vet. Same posture as ABN changes.
  const bankChanged = req.body.bank_account
    && JSON.stringify(req.body.bank_account)
       !== JSON.stringify(existing.bank_account?.toObject?.() || existing.bank_account || {});
  const abnChanged = req.body.abn && req.body.abn !== existing.abn;

  const updateData = {
    ...req.body,
    updated_by: req.user.userId
  };
  if ((bankChanged || abnChanged) && existing.vetting_status === 'approved') {
    updateData.vetting_status = 'draft';
    updateData.approval_request_id = null;
    updateData.vetted_at = null;
    updateData.vetted_by = null;
    updateData.expires_at = null;
    logInfo('Supplier material change forced re-vet', { supplierId: existing._id, abnChanged, bankChanged });
  }

  const updated = await repo.update(req.params.supplierId, updateData);
  res.json({ success: true, data: updated });
});

// ─── DELETE (soft) ─────────────────────────────────────────────────────
export const deleteSupplier = asyncHandler(async (req, res) => {
  const repo = new SupplierRepository(req.tenantDb);
  const existing = await repo.findById(req.params.supplierId);
  if (!existing) throw new AppError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');
  // Soft delete — preserve audit history. Hard delete via separate
  // admin-only endpoint if ever needed.
  await repo.update(req.params.supplierId, { is_active: false, updated_by: req.user.userId });
  res.json({ success: true, data: { _id: existing._id, is_active: false } });
});

// ─── SUBMIT FOR VETTING ────────────────────────────────────────────────
// Resolves the org's supplier_vetting matrix, builds the approval-step
// list from the configured approvers, and creates the ApprovalRequest.
// Flips the supplier into pending_review.
export const submitForVetting = asyncHandler(async (req, res) => {
  const tenantDb = req.tenantDb;
  const supplierRepo = new SupplierRepository(tenantDb);
  const supplier = await supplierRepo.findById(req.params.supplierId);
  if (!supplier) throw new AppError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');

  if (!['draft', 'rejected'].includes(supplier.vetting_status)) {
    throw new AppError(
      `Supplier is already ${supplier.vetting_status}. Re-vet via the re-vet action.`,
      400,
      'INVALID_STATUS'
    );
  }

  const orgId = await orgObjectIdFromTenant(tenantDb);

  const matrixRepo = new ApprovalMatrixRepository(tenantDb);
  const matrices = await matrixRepo.findByOrgId(orgId);
  // Match by EITHER the matrix-level workflow_category (modern field) OR
  // a rule's action_type === 'supplier_vetting' (legacy lookup partner /
  // COI still use). Belt + braces so the supplier flow finds the matrix
  // however the workflow tab decides to save it.
  const matrix = (matrices || []).find((m) => {
    const isActive = m.is_active !== false;
    if (!isActive) return false;
    if (m.workflow_category === 'supplier_vetting') return true;
    const rules = m.rules || m.approval_rules || [];
    return rules.some((r) => r.action_type === 'supplier_vetting' && r.is_active !== false);
  });
  if (!matrix) {
    throw new AppError(
      'No active Supplier Vetting workflow is configured. Configure one in Role Permissions → Approval Workflows.',
      400,
      'WORKFLOW_NOT_CONFIGURED'
    );
  }

  // Reuse the CoiWorkflowService's approver-resolution helper — it
  // already does the position-to-user expansion + department fallback.
  // We pass the matrix as the rule because supplier_vetting has only
  // one rule (single-workflow category).
  const workflowService = new CoiWorkflowService(req.orgId);
  const rule = matrix.rules?.[0] || matrix.approval_rules?.[0] || matrix;
  const approvers = await workflowService.resolveApprovers(
    matrix.rules ? { approval_rules: [rule] } : matrix,
    orgId
  );
  if (!approvers || approvers.length === 0) {
    throw new AppError(
      'Supplier Vetting workflow has no approvers configured.',
      400,
      'NO_APPROVERS'
    );
  }

  const approvalSteps = approvers.map((a) => ({
    level: a.level,
    approver_user_id: a.user_id,
    approver_position_id: a.position_id,
    approver_department_id: a.department_id,
    status: 'pending'
  }));

  // Build the ApprovalRequest payload. The schema requires
  // `entity_id`, `entity_type`, `request_type`, and `amount` — NOT
  // `parent_entity_id` / `parent_entity_type` (those are COI-only
  // fields used when a COI declaration is spawned off a parent
  // workflow). Supplier vetting has no dollar value so `amount: 0`
  // satisfies the `min: 0` validator without implying a real spend.
  const approvalRepo = new ApprovalRequestRepository(tenantDb);
  const request = await approvalRepo.create({
    org_id: orgId,
    request_type: 'supplier_vetting',
    entity_id: supplier._id,
    entity_type: 'supplier',
    amount: 0,
    workflow_category: 'supplier_vetting',
    workflow_type: null,
    approval_matrix_id: matrix._id,
    approval_type: matrix.approval_type || 'sequential',
    approval_steps: approvalSteps,
    submitted_by: req.user.userId,
    status: 'pending',
    title: `Supplier vetting — ${supplier.legal_name}`,
    description: `Supplier ${supplier.supplier_number}: vetting workflow`
  });

  const updated = await supplierRepo.update(supplier._id, {
    vetting_status: 'pending_review',
    approval_request_id: request._id,
    rejection_reason: null,
    updated_by: req.user.userId
  });

  logInfo('Supplier submitted for vetting', {
    supplierId: supplier._id, approvalRequestId: request._id
  });
  res.json({ success: true, data: updated });
});

// ─── REVET (approved → pending_review) ─────────────────────────────────
// Used when an approved supplier needs a fresh review (e.g. annual
// re-check or material change that wasn't auto-detected). Same flow
// as submit, but the previous approval record stays linked for the
// audit trail.
export const revetSupplier = asyncHandler(async (req, res) => {
  const supplierRepo = new SupplierRepository(req.tenantDb);
  const supplier = await supplierRepo.findById(req.params.supplierId);
  if (!supplier) throw new AppError('Supplier not found', 404, 'SUPPLIER_NOT_FOUND');
  if (supplier.vetting_status !== 'approved') {
    throw new AppError('Only approved suppliers can be re-vetted.', 400, 'INVALID_STATUS');
  }
  await supplierRepo.update(supplier._id, { vetting_status: 'draft', updated_by: req.user.userId });
  // Now reuse the submit flow:
  req.params.supplierId = String(supplier._id);
  return submitForVetting(req, res);
});

// ─── FINALIZE FROM APPROVAL ENGINE ─────────────────────────────────────
// Called by approvalRequest's "complete" hook (added in a sibling edit).
// Public surface kept lean — the approval engine module imports this
// directly rather than reaching it over HTTP.
export async function finalizeFromApprovalRequest(tenantDb, request) {
  // Read entity_id / entity_type (the general approval-request shape)
  // not the COI-specific parent_entity_* fields.
  if (!request || request.entity_type !== 'supplier') return;
  const supplierRepo = new SupplierRepository(tenantDb);
  const supplier = await supplierRepo.findById(request.entity_id);
  if (!supplier) return;
  const overall = request.status; // 'approved' | 'rejected' | 'pending'
  if (overall === 'approved') {
    // Default 1y expiry — admin can override per-supplier.
    const expiresAt = supplier.expires_at
      || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await supplierRepo.update(supplier._id, {
      vetting_status: 'approved',
      vetted_at: new Date(),
      vetted_by: request.last_action_by || null,
      expires_at: expiresAt
    });
    logInfo('Supplier approved via workflow', { supplierId: supplier._id });
  } else if (overall === 'rejected') {
    await supplierRepo.update(supplier._id, {
      vetting_status: 'rejected',
      rejection_reason: request.rejection_reason || null,
      vetted_at: new Date(),
      vetted_by: request.last_action_by || null
    });
    logInfo('Supplier rejected via workflow', { supplierId: supplier._id });
  }
}

// ─── LINKED EXPENSES ───────────────────────────────────────────────────
// Used by the supplier detail page to surface the history of expenses
// that reference this supplier.
export const getLinkedExpenses = asyncHandler(async (req, res) => {
  try {
    const expenseRepo = new ExpenseRepository(req.tenantDb);
    const expenses = await expenseRepo.Expense
      .find({ supplier_id: req.params.supplierId })
      .select('_id title amount status submitted_at createdAt currency')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: expenses });
  } catch (err) {
    logError('Linked expenses lookup failed', { error: err.message });
    res.json({ success: true, data: [] });
  }
});
