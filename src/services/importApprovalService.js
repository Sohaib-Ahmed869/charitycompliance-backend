/**
 * importApprovalService — raise an approval workflow for a record.
 *
 * Extracted from `supplierController.submitForVetting` so the same
 * "find the org's matrix → resolve approvers → create an ApprovalRequest"
 * flow can be reused by the bulk-import engine (and any future feature
 * that needs to route a record for approval).
 *
 * It deliberately mirrors the single-record submit path so an imported
 * record ends up identical to one submitted by hand:
 *   - matrix lookup matches EITHER the modern matrix-level
 *     `workflow_category` OR a legacy rule `action_type`
 *   - approver resolution reuses `CoiWorkflowService.resolveApprovers`
 *     (position→user expansion + department fallback)
 *
 * Throws typed errors the caller can branch on without inspecting the
 * message:
 *   - code `WORKFLOW_NOT_CONFIGURED` — no active matrix for the category
 *   - code `NO_APPROVERS`           — matrix exists but resolved to nobody
 */

import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { CoiWorkflowService } from './coiWorkflowService.js';

const typedError = (message, code) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

/**
 * Raise (create) an ApprovalRequest for a single entity.
 *
 * @param {object}  args
 * @param {import('mongoose').Connection} args.tenantDb  tenant connection
 * @param {string}  args.orgSlug     lowercase tenant slug (req.orgId) — used to
 *                                    build the CoiWorkflowService tenant connection
 * @param {import('mongoose').Types.ObjectId} args.orgObjectId  Organization _id
 * @param {string}  args.category    workflow_category, e.g. 'supplier_vetting'
 * @param {string}  args.requestType ApprovalRequest.request_type + rule action_type
 * @param {string}  args.entityType  ApprovalRequest.entity_type, e.g. 'supplier'
 * @param {object}  args.entity      the created record (needs `_id`)
 * @param {number} [args.amount=0]   dollar amount (0 for non-financial flows)
 * @param {import('mongoose').Types.ObjectId} args.submittedBy  requesting user _id
 * @param {string} [args.title]
 * @param {string} [args.description]
 * @returns {Promise<object>} the created ApprovalRequest document
 */
export const raiseEntityApproval = async ({
  tenantDb,
  orgSlug,
  orgObjectId,
  category,
  requestType,
  entityType,
  entity,
  amount = 0,
  submittedBy,
  title,
  description
}) => {
  const matrixRepo = new ApprovalMatrixRepository(tenantDb);
  const matrices = await matrixRepo.findByOrgId(orgObjectId);

  // Match by EITHER the matrix-level workflow_category (modern field) OR a
  // rule's action_type (legacy lookup). Belt + braces so the flow finds the
  // matrix however the workflow tab decided to save it.
  const matrix = (matrices || []).find((m) => {
    if (m.is_active === false) return false;
    if (m.workflow_category === category) return true;
    const rules = m.rules || m.approval_rules || [];
    return rules.some((r) => r.action_type === requestType && r.is_active !== false);
  });
  if (!matrix) {
    throw typedError(
      `No active workflow is configured for ${category}. Configure one in Role Permissions → Approval Workflows.`,
      'WORKFLOW_NOT_CONFIGURED'
    );
  }

  // supplier_vetting / COI / partner-vetting are single-rule categories, so
  // pass the matrix's first rule through the COI approver resolver.
  const workflowService = new CoiWorkflowService(orgSlug);
  const rule = matrix.rules?.[0] || matrix.approval_rules?.[0] || matrix;
  const approvers = await workflowService.resolveApprovers(
    matrix.rules ? { approval_rules: [rule] } : matrix,
    orgObjectId
  );
  if (!approvers || approvers.length === 0) {
    throw typedError(
      `The ${category} workflow has no approvers configured.`,
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

  const approvalRepo = new ApprovalRequestRepository(tenantDb);
  return approvalRepo.create({
    org_id: orgObjectId,
    request_type: requestType,
    entity_id: entity._id,
    entity_type: entityType,
    amount,
    workflow_category: category,
    workflow_type: null,
    approval_matrix_id: matrix._id,
    approval_type: matrix.approval_type || 'sequential',
    approval_steps: approvalSteps,
    submitted_by: submittedBy,
    status: 'pending',
    title: title || undefined,
    description: description || undefined
  });
};

export default { raiseEntityApproval };
