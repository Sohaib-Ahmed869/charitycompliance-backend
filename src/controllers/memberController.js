/**
 * Member Controller
 *
 * Members Register CRUD. Mounted at /api/v1/platform/members in app.js.
 *
 * Approval posture (the core requirement):
 *   - createMember: creates the member, then checks whether the org has an
 *     active "Member Approvals" (members_approval) workflow configured.
 *       • Configured   → spawn an ApprovalRequest and set status
 *                        `pending_approval`. The approval engine flips the
 *                        member to approved/rejected when it settles
 *                        (see finalizeFromApprovalRequest).
 *       • Not configured → leave the member `approved` (auto-approve).
 *   - finalizeFromApprovalRequest: invoked by the approval engine on settle.
 */

import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { MemberRepository } from '../repositories/memberRepository.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { CoiWorkflowService } from '../services/coiWorkflowService.js';
import { logInfo, logError } from '../utils/logger.js';

const orgObjectIdFromTenant = async (tenantDb) => {
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  return org._id;
};

/** Find the org's active Member Approvals matrix, or null. */
const findMembersMatrix = (matrices) =>
  (matrices || []).find((m) => {
    if (m.is_active === false) return false;
    if (m.workflow_category === 'members_approval') return true;
    const rules = m.rules || m.approval_rules || [];
    return rules.some((r) => r.action_type === 'members' && r.is_active !== false);
  }) || null;

// ─── LIST ──────────────────────────────────────────────────────────────
export const listMembers = asyncHandler(async (req, res) => {
  const repo = new MemberRepository(req.tenantDb);
  const orgId = await orgObjectIdFromTenant(req.tenantDb);
  const { status, membership_type, is_active, search } = req.query;
  const filters = {
    status,
    membership_type,
    search,
    is_active: typeof is_active === 'string' ? is_active === 'true' : undefined
  };
  const members = await repo.findByOrgId(orgId, filters);
  res.json({ success: true, data: members });
});

// ─── COUNTS (KpiStrip) ─────────────────────────────────────────────────
export const getMemberCounts = asyncHandler(async (req, res) => {
  const repo = new MemberRepository(req.tenantDb);
  const orgId = await orgObjectIdFromTenant(req.tenantDb);
  const counts = await repo.getCountsByOrg(orgId);
  res.json({ success: true, data: counts });
});

// ─── DETAIL ────────────────────────────────────────────────────────────
export const getMemberById = asyncHandler(async (req, res) => {
  const repo = new MemberRepository(req.tenantDb);
  const member = await repo.findByIdWithWorkflow(req.params.memberId);
  if (!member) throw new AppError('Member not found', 404, 'MEMBER_NOT_FOUND');
  res.json({ success: true, data: member });
});

// ─── CREATE (with optional approval workflow) ──────────────────────────
export const createMember = asyncHandler(async (req, res) => {
  const tenantDb = req.tenantDb;
  const repo = new MemberRepository(tenantDb);
  const orgId = await orgObjectIdFromTenant(tenantDb);

  const member_number = req.body.member_number || await repo.nextMemberNumber(orgId);

  // Create as approved by default; downgrade to pending below if a workflow
  // is configured. date_joined defaults to today when not supplied.
  let member = await repo.create({
    ...req.body,
    member_number,
    org_id: orgId,
    status: 'approved',
    approved_at: new Date(),
    approved_by: req.user.userId,
    date_joined: req.body.date_joined ? new Date(req.body.date_joined) : new Date(),
    created_by: req.user.userId,
    updated_by: req.user.userId
  });

  // Gate on a configured Member Approvals workflow. Any failure here must
  // NOT block member creation — the member simply stays auto-approved.
  try {
    const matrixRepo = new ApprovalMatrixRepository(tenantDb);
    const matrices = await matrixRepo.findByOrgId(orgId);
    const matrix = findMembersMatrix(matrices);

    if (matrix) {
      const workflowService = new CoiWorkflowService(req.orgId);
      const rule = matrix.rules?.[0] || matrix.approval_rules?.[0] || matrix;
      const approvers = await workflowService.resolveApprovers(
        matrix.rules ? { approval_rules: [rule] } : matrix,
        orgId
      );

      if (Array.isArray(approvers) && approvers.length > 0) {
        const approvalSteps = approvers.map((a) => ({
          level: a.level,
          approver_user_id: a.user_id,
          approver_position_id: a.position_id,
          approver_department_id: a.department_id,
          status: 'pending'
        }));

        const approvalRepo = new ApprovalRequestRepository(tenantDb);
        const request = await approvalRepo.create({
          org_id: orgId,
          request_type: 'members',
          entity_id: member._id,
          entity_type: 'member',
          amount: 0,
          workflow_category: 'members_approval',
          workflow_type: null,
          approval_matrix_id: matrix._id,
          approval_type: matrix.approval_type || 'sequential',
          approval_steps: approvalSteps,
          submitted_by: req.user.userId,
          status: 'pending',
          title: `Member approval — ${member.full_name}`,
          description: `Member ${member.member_number}: registration approval`
        });

        member = await repo.update(member._id, {
          status: 'pending_approval',
          approval_request_id: request._id,
          approved_at: null,
          approved_by: null
        });
        logInfo('Member submitted to approval workflow', { memberId: member._id, approvalRequestId: request._id });
      }
      // Matrix exists but no approvers resolved → leave auto-approved.
    }
  } catch (err) {
    logError('Member approval workflow gating failed; left as approved', { error: err?.message });
  }

  logInfo('Member created', { memberId: member._id, orgId, status: member.status });
  res.status(201).json({ success: true, data: member });
});

// ─── UPDATE ────────────────────────────────────────────────────────────
export const updateMember = asyncHandler(async (req, res) => {
  const repo = new MemberRepository(req.tenantDb);
  const existing = await repo.findById(req.params.memberId);
  if (!existing) throw new AppError('Member not found', 404, 'MEMBER_NOT_FOUND');

  // Never let the client steer approval lifecycle fields directly.
  const { status, approval_request_id, approved_at, approved_by, org_id, member_number, ...safe } = req.body;
  const updated = await repo.update(req.params.memberId, {
    ...safe,
    updated_by: req.user.userId
  });
  res.json({ success: true, data: updated });
});

// ─── DELETE (soft) ─────────────────────────────────────────────────────
export const deleteMember = asyncHandler(async (req, res) => {
  const repo = new MemberRepository(req.tenantDb);
  const existing = await repo.findById(req.params.memberId);
  if (!existing) throw new AppError('Member not found', 404, 'MEMBER_NOT_FOUND');
  await repo.update(req.params.memberId, { is_active: false, updated_by: req.user.userId });
  res.json({ success: true, data: { _id: existing._id, is_active: false } });
});

// ─── FINALIZE FROM APPROVAL ENGINE ─────────────────────────────────────
// Called by approvalWorkflowService when a member's ApprovalRequest settles.
export async function finalizeFromApprovalRequest(tenantDb, request) {
  if (!request || request.entity_type !== 'member') return;
  const repo = new MemberRepository(tenantDb);
  const member = await repo.findById(request.entity_id);
  if (!member) return;

  if (request.status === 'approved') {
    await repo.update(member._id, {
      status: 'approved',
      approved_at: new Date(),
      approved_by: request.last_action_by || null,
      rejection_reason: null
    });
    logInfo('Member approved via workflow', { memberId: member._id });
  } else if (request.status === 'rejected') {
    await repo.update(member._id, {
      status: 'rejected',
      rejection_reason: request.rejection_reason || null,
      approved_at: new Date(),
      approved_by: request.last_action_by || null
    });
    logInfo('Member rejected via workflow', { memberId: member._id });
  }
}
