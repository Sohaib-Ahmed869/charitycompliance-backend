/**
 * Audit Trail Controller
 *
 * Aggregates workflow actions across approvals and COI requests.
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import policySchema from '../db/schemas/platform/policySchema.js';
import expenseSchema from '../db/schemas/platform/expenseSchema.js';
import complaintSchema from '../db/schemas/platform/complaintSchema.js';
import riskSchema from '../db/schemas/platform/riskSchema.js';

const toName = (user) => {
  if (!user) return '—';
  const name = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  return name || user.email || '—';
};

const toRole = (user) => {
  if (!user) return null;
  if (user.is_org_owner) return 'Admin';
  return user.role || user.position || null;
};

const normalizeEvent = (event) => ({
  id: event.id,
  timestamp: event.timestamp,
  actor: event.actor,
  action: event.action,
  module: event.module,
  request_type: event.request_type,
  request_id: event.request_id,
  details: event.details || null,
  step: event.step || null,
  source: event.source
});

export const getAuditTrail = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = req.tenantDb || await getTenantConnection(orgId);

  // Admin-only: verify org owner
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(req.user?.userId);
  if (!user?.is_org_owner) {
    throw new AppError('Only admins can access audit trail', 403, 'ADMIN_ONLY');
  }

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Ensure models for entity lookups
  const Policy = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
  const Expense = tenantDb.models.Expense || tenantDb.model('Expense', expenseSchema);
  const Complaint = tenantDb.models.Complaint || tenantDb.model('Complaint', complaintSchema);
  const Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);

  const approvalRepo = new ApprovalRequestRepository(tenantDb);
  // Use model directly to populate rejection reviews
  const ApprovalRequest = tenantDb.models.ApprovalRequest;
  const approvals = await ApprovalRequest.find({ org_id: org._id })
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
    .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
    .sort({ created_at: -1 })
    .lean();

  const coiRepo = new CoiRequestRepository(tenantDb);
  const CoiRequest = tenantDb.models.CoiRequest;
  const coiRequests = await CoiRequest.find({ org_id: org._id })
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .sort({ created_at: -1 })
    .lean();

  const events = [];

  const policyIds = approvals
    .filter((reqDoc) => reqDoc.entity_type === 'policy' && reqDoc.entity_id)
    .map((reqDoc) => reqDoc.entity_id);
  const expenseIds = approvals
    .filter((reqDoc) => reqDoc.entity_type === 'expense' && reqDoc.entity_id)
    .map((reqDoc) => reqDoc.entity_id);
  const riskIds = approvals
    .filter((reqDoc) => reqDoc.entity_type === 'risk' && reqDoc.entity_id)
    .map((reqDoc) => reqDoc.entity_id);

  const [policies, expenses, risks] = await Promise.all([
    policyIds.length
      ? Policy.find({ _id: { $in: policyIds } })
          .select('title category version status')
          .lean()
      : Promise.resolve([]),
    expenseIds.length
      ? Expense.find({ _id: { $in: expenseIds } })
          .select('amount category vendor_name description status')
          .lean()
      : Promise.resolve([]),
    riskIds.length
      ? Risk.find({ _id: { $in: riskIds } })
          .select('title category status')
          .lean()
      : Promise.resolve([])
  ]);

  const policyMap = new Map(policies.map((item) => [item._id?.toString(), item]));
  const expenseMap = new Map(expenses.map((item) => [item._id?.toString(), item]));
  const riskMap = new Map(risks.map((item) => [item._id?.toString(), item]));

  approvals.forEach((reqDoc) => {
    const requestId = reqDoc._id?.toString();
    const requestType = reqDoc.request_type;
    const module = reqDoc.entity_type || reqDoc.request_type;
    const entityId = reqDoc.entity_id?.toString();
    const policy = entityId ? policyMap.get(entityId) : null;
    const expense = entityId ? expenseMap.get(entityId) : null;
    const risk = entityId ? riskMap.get(entityId) : null;

    const submittedAction = module === 'policy'
      ? 'Policy update submitted'
      : module === 'expense'
      ? 'Expense submitted for approval'
      : module === 'risk'
      ? 'Risk submitted for approval'
      : 'Submitted approval request';

    // Submitted event
    events.push(normalizeEvent({
      id: `approval-submitted-${requestId}`,
      timestamp: reqDoc.created_at,
      actor: {
        id: reqDoc.submitted_by?._id?.toString(),
        name: toName(reqDoc.submitted_by),
        role: toRole(reqDoc.submitted_by)
      },
      action: submittedAction,
      module,
      request_type: requestType,
      request_id: requestId,
      details: {
        status: reqDoc.status,
        approval_type: reqDoc.approval_type,
        entity_id: entityId || null,
        entity_title: policy?.title || expense?.description || risk?.title || null,
        entity_category: policy?.category || expense?.category || risk?.category || null,
        entity_version: policy?.version || null,
        amount: expense?.amount ?? reqDoc.amount ?? null,
        vendor: expense?.vendor_name || null
      },
      source: 'approval'
    }));

    if (reqDoc.status === 'paused_for_coi' && reqDoc.paused_at) {
      events.push(normalizeEvent({
        id: `approval-coi-paused-${requestId}`,
        timestamp: reqDoc.paused_at,
        actor: {
          id: reqDoc.submitted_by?._id?.toString(),
          name: toName(reqDoc.submitted_by),
          role: toRole(reqDoc.submitted_by)
        },
        action: 'Paused for COI',
        module,
        request_type: requestType,
        request_id: requestId,
        details: {
          coi_request_id: reqDoc.current_coi_request_id || null
        },
        source: 'approval'
      }));
    }

    (reqDoc.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `approval-step-approved-${requestId}-${idx}`,
          timestamp: step.approved_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Approved request',
          module,
          request_type: requestType,
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            comments: step.comments || null,
            acknowledgement_note: step.acknowledgement_note || null,
            acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null
          },
          source: 'approval'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `approval-step-rejected-${requestId}-${idx}`,
          timestamp: step.rejected_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Rejected request',
          module,
          request_type: requestType,
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            reason: step.rejection_reason || step.comments || null,
            acknowledgement_note: step.acknowledgement_note || null,
            acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null
          },
          source: 'approval'
        }));
      }
    });

    (reqDoc.rejection_reviews || []).forEach((review, idx) => {
      events.push(normalizeEvent({
        id: `rejection-forwarded-${requestId}-${idx}`,
        timestamp: review.created_at,
        actor: {
          id: review.rejected_by?._id?.toString(),
          name: toName(review.rejected_by),
          role: toRole(review.rejected_by)
        },
        action: 'Forwarded rejection',
        module,
        request_type: requestType,
        request_id: requestId,
        details: {
          forwarded_to: toName(review.forwarded_to),
          comments: review.rejection_comments || null,
          step_index: review.step_index
        },
        source: 'rejection_review'
      }));

      if (review.review_action && review.reviewed_at) {
        events.push(normalizeEvent({
          id: `rejection-reviewed-${requestId}-${idx}`,
          timestamp: review.reviewed_at,
          actor: {
            id: review.forwarded_to?._id?.toString(),
            name: toName(review.forwarded_to),
            role: toRole(review.forwarded_to)
          },
          action: review.review_action === 'accept_rejection' ? 'Rejection accepted' : 'Rejection declined',
          module,
          request_type: requestType,
          request_id: requestId,
          details: {
            review_comments: review.review_comments || null
          },
          source: 'rejection_review'
        }));
      }
    });
  });

  coiRequests.forEach((coi) => {
    const requestId = coi._id?.toString();
    const module = 'coi';

    events.push(normalizeEvent({
      id: `coi-submitted-${requestId}`,
      timestamp: coi.created_at,
      actor: {
        id: coi.submitted_by?._id?.toString(),
        name: toName(coi.submitted_by),
        role: toRole(coi.submitted_by)
      },
      action: 'Submitted COI',
      module,
      request_type: 'coi',
      request_id: requestId,
      details: {
        reason: coi.coi_reason || null,
        parent_approval_request_id: coi.parent_approval_request_id?.toString() || null
      },
      source: 'coi'
    }));

    (coi.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `coi-step-approved-${requestId}-${idx}`,
          timestamp: step.approved_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Approved COI step',
          module,
          request_type: 'coi',
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            comments: step.comments || null
          },
          source: 'coi'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `coi-step-rejected-${requestId}-${idx}`,
          timestamp: step.rejected_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Rejected COI step',
          module,
          request_type: 'coi',
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            reason: step.rejection_reason || step.comments || null
          },
          source: 'coi'
        }));
      }
    });
  });

  // Complaint workflow events (prefer explicit complaint.trail; fallback to derived resolution events)
  const complaints = await Complaint.find({
    org_id: org._id,
    $or: [
      { trail: { $exists: true, $ne: [] } },
      { 'resolution_details.root_cause': { $exists: true, $ne: '' } },
      { 'resolution_details.risk_linked_at': { $exists: true } },
      { 'resolution_details.training_linked_at': { $exists: true } },
      { status: 'resolved' }
    ]
  })
    .populate('assigned_to', 'first_name last_name email is_org_owner role position')
    .populate('trail.actor_user_id', 'first_name last_name email is_org_owner role position')
    .lean();

  const complaintRiskIds = complaints
    .map((item) => item.linked_risk_id?.toString())
    .filter(Boolean);
  const complaintRiskMap = complaintRiskIds.length
    ? new Map(
        (await Risk.find({ _id: { $in: complaintRiskIds } })
          .select('title')
          .lean()
        ).map((item) => [item._id?.toString(), item])
      )
    : new Map();

  const complaintActionLabel = (a) => {
    const map = {
      created: 'Complaint created',
      admin_triage_completed: 'Admin review completed',
      dept_head_completed: 'Department head completed',
      major_flag_set: 'Major flag updated',
      board_signoff_selected: 'Board approval selected',
      escalated: 'Escalated',
      deescalated: 'De-escalated',
      resolution_details_saved: 'Resolution details saved',
      risk_linked: 'Risk linked to complaint',
      training_linked: 'Training linked to complaint',
      signed_off: 'Board approval completed',
      resolved: 'Complaint resolved',
    };
    return map[a] || a || 'Complaint updated';
  };

  complaints.forEach((complaint) => {
    const complaintId = complaint._id?.toString();
    const resolutionDetails = complaint.resolution_details || {};

    if (Array.isArray(complaint.trail) && complaint.trail.length > 0) {
      complaint.trail.forEach((t, idx) => {
        const actorUser = t?.actor_user_id;
        events.push(normalizeEvent({
          id: `complaint-trail-${complaintId}-${idx}`,
          timestamp: t?.at || complaint.updated_at,
          actor: {
            id: actorUser?._id?.toString() || actorUser?.toString?.(),
            name: toName(actorUser),
            role: toRole(actorUser)
          },
          action: complaintActionLabel(t?.action),
          module: 'complaint',
          request_type: 'complaint',
          request_id: complaintId,
          details: {
            complaint_title: complaint.complaint_title,
            ...(t?.details || {})
          },
          source: 'complaint'
        }));
      });
      return;
    }

    // Fallback (older records without trail)
    const actorUser = complaint.assigned_to;
    const actor = {
      id: actorUser?._id?.toString(),
      name: toName(actorUser),
      role: toRole(actorUser)
    };

    if (resolutionDetails.root_cause) {
      events.push(normalizeEvent({
        id: `complaint-resolution-${complaintId}`,
        timestamp: resolutionDetails.completed_at || complaint.updated_at,
        actor,
        action: 'Resolution details saved',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title
        },
        source: 'complaint'
      }));
    }

    if (complaint.linked_risk_id) {
      const riskTitle = complaintRiskMap.get(complaint.linked_risk_id?.toString())?.title || null;
      events.push(normalizeEvent({
        id: `complaint-risk-${complaintId}`,
        timestamp: resolutionDetails.risk_linked_at || complaint.updated_at,
        actor,
        action: 'Risk linked to complaint',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title,
          risk_title: riskTitle,
          risk_id: complaint.linked_risk_id?.toString()
        },
        source: 'complaint'
      }));
    }

    if (complaint.linked_training_id) {
      events.push(normalizeEvent({
        id: `complaint-training-${complaintId}`,
        timestamp: resolutionDetails.training_linked_at || complaint.updated_at,
        actor,
        action: 'Training linked to complaint',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title,
          training_title: complaint.training_attachment?.training_title || null,
          training_id: complaint.linked_training_id?.toString()
        },
        source: 'complaint'
      }));
    }

    if (complaint.status === 'resolved') {
      events.push(normalizeEvent({
        id: `complaint-resolved-${complaintId}`,
        timestamp: resolutionDetails.resolved_at || complaint.updated_at,
        actor,
        action: 'Complaint resolved',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title
        },
        source: 'complaint'
      }));
    }
  });

  const sorted = events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  res.json({
    success: true,
    data: sorted
  });
});

/**
 * Download Audit Trail PDF for a single request
 * GET /platform/audit-trail/download/:requestId
 */
export const downloadAuditTrailPDF = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { requestId } = req.params;
  const tenantDb = req.tenantDb || await getTenantConnection(orgId);

  // Admin-only
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(req.user?.userId);
  if (!user?.is_org_owner) {
    throw new AppError('Only admins can download audit trail PDFs', 403, 'ADMIN_ONLY');
  }

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const logoUrl = org?.logo_url || process.env.LOGO || '';

  // Ensure models
  const Policy = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
  const Expense = tenantDb.models.Expense || tenantDb.model('Expense', expenseSchema);
  const Complaint = tenantDb.models.Complaint || tenantDb.model('Complaint', complaintSchema);
  const Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);

  // Try to find as an approval request first
  const ApprovalRequest = tenantDb.models.ApprovalRequest;
  let reqDoc = await ApprovalRequest.findById(requestId)
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
    .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
    .lean();

  let source = 'approval';
  let module = '';
  let entityInfo = {};

  if (!reqDoc) {
    // Try COI request
    const CoiRequest = tenantDb.models.CoiRequest;
    reqDoc = await CoiRequest.findById(requestId)
      .populate('submitted_by', 'first_name last_name email is_org_owner')
      .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .lean();
    source = 'coi';
  }

  if (!reqDoc) {
    // Try complaint
    const complaint = await Complaint.findById(requestId)
      .populate('assigned_to', 'first_name last_name email is_org_owner role position')
      .lean();
    if (complaint) {
      reqDoc = complaint;
      source = 'complaint';
    }
  }

  if (!reqDoc) {
    throw new AppError('Request not found', 404, 'NOT_FOUND');
  }

  // Build events for this single request (same logic as getAuditTrail but filtered)
  const events = [];

  if (source === 'approval') {
    module = reqDoc.entity_type || reqDoc.request_type;
    const entityId = reqDoc.entity_id?.toString();

    // Fetch entity details
    if (entityId) {
      if (module === 'policy') {
        const p = await Policy.findById(entityId).select('title category version status').lean();
        if (p) entityInfo = { title: p.title, category: p.category, version: p.version };
      } else if (module === 'expense') {
        const e = await Expense.findById(entityId).select('amount category vendor_name description status').lean();
        if (e) entityInfo = { title: e.description, category: e.category, amount: e.amount, vendor: e.vendor_name };
      } else if (module === 'risk') {
        const r = await Risk.findById(entityId).select('title category status').lean();
        if (r) entityInfo = { title: r.title, category: r.category };
      }
    }

    // Submitted
    events.push(normalizeEvent({
      id: `approval-submitted-${requestId}`,
      timestamp: reqDoc.created_at,
      actor: { id: reqDoc.submitted_by?._id?.toString(), name: toName(reqDoc.submitted_by), role: toRole(reqDoc.submitted_by) },
      action: module === 'policy' ? 'Policy update submitted' : module === 'expense' ? 'Expense submitted for approval' : module === 'risk' ? 'Risk submitted for approval' : 'Submitted approval request',
      module, request_type: reqDoc.request_type, request_id: requestId,
      details: { status: reqDoc.status, approval_type: reqDoc.approval_type, entity_title: entityInfo.title || null, amount: entityInfo.amount || null, vendor: entityInfo.vendor || null },
      source: 'approval'
    }));

    if (reqDoc.status === 'paused_for_coi' && reqDoc.paused_at) {
      events.push(normalizeEvent({
        id: `approval-coi-paused-${requestId}`, timestamp: reqDoc.paused_at,
        actor: { id: reqDoc.submitted_by?._id?.toString(), name: toName(reqDoc.submitted_by), role: toRole(reqDoc.submitted_by) },
        action: 'Paused for COI', module, request_type: reqDoc.request_type, request_id: requestId,
        details: { coi_request_id: reqDoc.current_coi_request_id || null }, source: 'approval'
      }));
    }

    (reqDoc.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `approval-step-approved-${requestId}-${idx}`, timestamp: step.approved_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Approved request', module, request_type: reqDoc.request_type, request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { comments: step.comments || null, acknowledgement_note: step.acknowledgement_note || null, acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null },
          source: 'approval'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `approval-step-rejected-${requestId}-${idx}`, timestamp: step.rejected_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Rejected request', module, request_type: reqDoc.request_type, request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { reason: step.rejection_reason || step.comments || null, acknowledgement_note: step.acknowledgement_note || null, acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null },
          source: 'approval'
        }));
      }
    });

    (reqDoc.rejection_reviews || []).forEach((review, idx) => {
      events.push(normalizeEvent({
        id: `rejection-forwarded-${requestId}-${idx}`, timestamp: review.created_at,
        actor: { id: review.rejected_by?._id?.toString(), name: toName(review.rejected_by), role: toRole(review.rejected_by) },
        action: 'Forwarded rejection', module, request_type: reqDoc.request_type, request_id: requestId,
        details: { forwarded_to: toName(review.forwarded_to), comments: review.rejection_comments || null, step_index: review.step_index },
        source: 'rejection_review'
      }));
      if (review.review_action && review.reviewed_at) {
        events.push(normalizeEvent({
          id: `rejection-reviewed-${requestId}-${idx}`, timestamp: review.reviewed_at,
          actor: { id: review.forwarded_to?._id?.toString(), name: toName(review.forwarded_to), role: toRole(review.forwarded_to) },
          action: review.review_action === 'accept_rejection' ? 'Rejection accepted' : 'Rejection declined',
          module, request_type: reqDoc.request_type, request_id: requestId,
          details: { review_comments: review.review_comments || null }, source: 'rejection_review'
        }));
      }
    });
  } else if (source === 'coi') {
    module = 'coi';
    events.push(normalizeEvent({
      id: `coi-submitted-${requestId}`, timestamp: reqDoc.created_at,
      actor: { id: reqDoc.submitted_by?._id?.toString(), name: toName(reqDoc.submitted_by), role: toRole(reqDoc.submitted_by) },
      action: 'Submitted COI', module, request_type: 'coi', request_id: requestId,
      details: { reason: reqDoc.coi_reason || null, parent_approval_request_id: reqDoc.parent_approval_request_id?.toString() || null },
      source: 'coi'
    }));
    (reqDoc.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `coi-step-approved-${requestId}-${idx}`, timestamp: step.approved_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Approved COI step', module, request_type: 'coi', request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { comments: step.comments || null }, source: 'coi'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `coi-step-rejected-${requestId}-${idx}`, timestamp: step.rejected_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Rejected COI step', module, request_type: 'coi', request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { reason: step.rejection_reason || step.comments || null }, source: 'coi'
        }));
      }
    });
  } else if (source === 'complaint') {
    module = 'complaint';
    const actorUser = reqDoc.assigned_to;
    const actor = { id: actorUser?._id?.toString(), name: toName(actorUser), role: toRole(actorUser) };
    const rd = reqDoc.resolution_details || {};
    entityInfo = { title: reqDoc.complaint_title };

    if (rd.root_cause) {
      events.push(normalizeEvent({
        id: `complaint-resolution-${requestId}`, timestamp: rd.completed_at || reqDoc.updated_at,
        actor, action: 'Resolution details saved', module, request_type: 'complaint', request_id: requestId,
        details: { complaint_title: reqDoc.complaint_title }, source: 'complaint'
      }));
    }
    if (reqDoc.linked_risk_id) {
      const riskDoc = await Risk.findById(reqDoc.linked_risk_id).select('title').lean();
      events.push(normalizeEvent({
        id: `complaint-risk-${requestId}`, timestamp: rd.risk_linked_at || reqDoc.updated_at,
        actor, action: 'Risk linked to complaint', module, request_type: 'complaint', request_id: requestId,
        details: { complaint_title: reqDoc.complaint_title, risk_title: riskDoc?.title || null }, source: 'complaint'
      }));
    }
    if (reqDoc.status === 'resolved') {
      events.push(normalizeEvent({
        id: `complaint-resolved-${requestId}`, timestamp: rd.resolved_at || reqDoc.updated_at,
        actor, action: 'Complaint resolved', module, request_type: 'complaint', request_id: requestId,
        details: { complaint_title: reqDoc.complaint_title }, source: 'complaint'
      }));
    }
  }

  const sorted = events.filter(e => e.timestamp).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Build unique actors set
  const actorMap = new Map();
  sorted.forEach(e => {
    if (e.actor?.id && !actorMap.has(e.actor.id)) {
      actorMap.set(e.actor.id, { name: e.actor.name, role: e.actor.role });
    }
  });
  const uniqueActors = Array.from(actorMap.values());

  // Generate PDF
  const { generateAuditTrailPDF } = await import('../services/auditTrailPdfService.js');
  const pdfBuffer = await generateAuditTrailPDF(sorted, uniqueActors, entityInfo, module, requestId, logoUrl);

  const fileName = `audit_trail_${requestId}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

export default { getAuditTrail, downloadAuditTrailPDF };
