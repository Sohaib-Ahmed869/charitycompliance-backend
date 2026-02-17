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

  approvals.forEach((reqDoc) => {
    const requestId = reqDoc._id?.toString();
    const requestType = reqDoc.request_type;
    const module = reqDoc.entity_type || reqDoc.request_type;

    // Submitted event
    events.push(normalizeEvent({
      id: `approval-submitted-${requestId}`,
      timestamp: reqDoc.created_at,
      actor: {
        id: reqDoc.submitted_by?._id?.toString(),
        name: toName(reqDoc.submitted_by),
        role: toRole(reqDoc.submitted_by)
      },
      action: 'Submitted approval request',
      module,
      request_type: requestType,
      request_id: requestId,
      details: {
        status: reqDoc.status,
        approval_type: reqDoc.approval_type
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
            comments: step.comments || null
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
            reason: step.rejection_reason || step.comments || null
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

  const sorted = events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  res.json({
    success: true,
    data: sorted
  });
});

export default { getAuditTrail };
