/**
 * Approval Request Repository
 * 
 * Manages approval request data operations
 */

import mongoose from 'mongoose';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import positionSchema from '../db/schemas/platform/positionSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';
import partnerVettingSchema from '../db/schemas/platform/partnerVettingSchema.js';
import { UserRepository } from './userRepository.js';

/**
 * Indices of the steps that are CURRENTLY awaiting a decision.
 *  - sequential: the first still-pending step (all earlier ones approved).
 *  - parallel / any: every pending step.
 * Used to stamp `activated_at` (drives approval reminders) and to route the
 * "approval needs your review" push to the right approver(s).
 */
function computeActiveStepIndices(steps = [], approvalType = 'sequential') {
  const pending = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const status = s?.status || 'pending';
    if (status === 'pending') pending.push(i);
  }
  if (!pending.length) return [];
  if (approvalType === 'parallel' || approvalType === 'any') return pending;
  // sequential — only the first pending step is active.
  return [pending[0]];
}

/** Human-friendly label for a request type (used in push copy). */
function humanizeRequestType(t) {
  return String(t || 'request').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Best-effort routed push to a set of approver user ids for an approval request.
 * Fully wrapped — never throws, never blocks the caller (spec §4/§5).
 */
async function fireRoutedApproverPush(tenantDb, requestId, requestType, approverUserIds) {
  const ids = [...new Set((approverUserIds || []).filter(Boolean).map(String))];
  if (!ids.length || !tenantDb) return;
  const id = String(requestId);
  const label = humanizeRequestType(requestType);

  // Persist an in-app notification for the newly-activated approver(s) — not just
  // a transient push. Without this, the next person in a sequential chain never
  // saw the pending step in their notifications list (a push alone was silently
  // lost if their device had no registered token). The repository mirrors every
  // created notification to mobile push, so no explicit send is needed here.
  // Best-effort; never blocks.
  try {
    const { NotificationRepository } = await import('./notificationRepository.js');
    const notificationRepo = new NotificationRepository(tenantDb);
    await notificationRepo.createMany(ids.map((uid) => ({
      user_id: uid,
      type: 'approval_pending',
      title: 'Approval needs your review',
      message: `${label} is awaiting your approval.`,
      link: `/approvals/${id}`,
      related_entity_id: requestId,
      related_entity_type: 'approval_request'
    })));
  } catch {
    // swallow — in-app notification is best-effort
  }
}

export class ApprovalRequestRepository {
  constructor(tenantDb) {
    // Ensure related models are registered on this tenant connection so populate() works
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
    tenantDb.models.PartnerVetting || tenantDb.model('PartnerVetting', partnerVettingSchema);
    
    // Register User model for populate() operations
    new UserRepository(tenantDb);

    this.ApprovalRequest = tenantDb.models.ApprovalRequest ||
      tenantDb.model('ApprovalRequest', approvalRequestSchema);
  }

  _normalizeApproverUserId(value) {
    const v = value?._id || value?.id || value;
    if (!v) return value;
    if (v instanceof mongoose.Types.ObjectId) return v;
    const s = String(v).trim();
    if (!s) return value;
    if (/^[a-fA-F0-9]{24}$/.test(s)) return new mongoose.Types.ObjectId(s);

    const cleaned = s
      .replace(/\\\\n/g, '\n')
      .replace(/\\\\'/g, "'")
      .replace(/\\"/g, '"');

    const any = cleaned.match(/[a-fA-F0-9]{24}/);
    if (any && any[0]) return new mongoose.Types.ObjectId(any[0]);
    return value;
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    
    if (filters.status) {
      query.status = filters.status;
    }
    
    if (filters.requestType) {
      query.request_type = filters.requestType;
    }
    
    if (filters.submittedBy) {
      query.submitted_by = filters.submittedBy;
    }
    
    return await this.ApprovalRequest.find(query)
      .populate('submitted_by', 'first_name last_name email is_org_owner')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.ApprovalRequest.findById(id)
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .populate('rejection_reviews.rejected_by', 'first_name last_name email')
      .populate('rejection_reviews.forwarded_to', 'first_name last_name email')
      .populate('escalations.escalated_by', 'first_name last_name email')
      .populate('escalations.escalated_to', 'first_name last_name email');
  }

  async findByEntityId(entityId, entityType) {
    return await this.ApprovalRequest.findOne({
      entity_id: entityId,
      entity_type: entityType
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name');
  }

  async findActiveByEntity(entityType, entityId) {
    return await this.ApprovalRequest.findOne({
      entity_id: entityId,
      entity_type: entityType,
      status: { $in: ['pending', 'in_progress'] }
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .sort({ created_at: -1 });
  }

  /**
   * All in-flight approval requests for an entity, populated for display.
   * "Active" = any non-terminal status (terminal = approved / rejected /
   * cancelled / rejection_accepted). Returns an array because some
   * entities (e.g. social media campaigns) can have two workflows in
   * flight at once. Powers the "routed for approval" banner on entity
   * pages — query by the reverse entity_id+entity_type link so it works
   * even for entities that don't store a forward approval_request_id.
   */
  async findAllActiveByEntity(entityType, entityId) {
    return await this.ApprovalRequest.find({
      entity_id: entityId,
      entity_type: entityType,
      status: { $in: ['pending', 'pending_rejection_review', 'returned_for_resubmission', 'paused_for_coi'] }
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .sort({ created_at: -1 });
  }

  async findPendingByApprover(userId, positionIds = []) {
    // Build query: match by user_id OR by position_id (position holders can always approve)
    // Use $elemMatch to ensure all conditions apply to the SAME array element
    const orConditions = [
      {
        status: { $in: ['pending', 'paused_for_coi'] },
        approval_steps: {
          $elemMatch: {
            approver_user_id: userId,
            status: 'pending'
          }
        }
      }
    ];

    // Match steps where user holds the approver position (works regardless of approver_user_id)
    // This ensures position holders see approvals even when a different user was pre-assigned
    if (positionIds && positionIds.length > 0) {
      orConditions.push({
        status: { $in: ['pending', 'paused_for_coi'] },
        approval_steps: {
          $elemMatch: {
            approver_position_id: { $in: positionIds },
            status: 'pending'
          }
        }
      });
    }

    // Also include pending rejection reviews where user is forwarded_to
    const rejectionReviewCondition = {
      status: 'pending_rejection_review',
      'rejection_reviews': {
        $elemMatch: {
          forwarded_to: userId,
          review_status: 'pending'
        }
      }
    };

    return await this.ApprovalRequest.find({
      $or: [
        ...orConditions,
        rejectionReviewCondition
      ]
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .populate('rejection_reviews.rejected_by', 'first_name last_name email')
      .populate('rejection_reviews.forwarded_to', 'first_name last_name email')
      .sort({ created_at: -1 });
  }

  async create(data) {
    // Last-line-of-defense: coerce any malformed approver_user_id into an ObjectId if possible.
    if (data?.approval_steps && Array.isArray(data.approval_steps)) {
      data.approval_steps = data.approval_steps.map((step) => {
        if (!step || typeof step !== 'object') return step;
        if (!Object.prototype.hasOwnProperty.call(step, 'approver_user_id')) return step;
        return {
          ...step,
          approver_user_id: this._normalizeApproverUserId(step.approver_user_id),
        };
      });
    }
    // Stamp activated_at on the step(s) that are immediately awaiting a
    // decision, so the approval reminder scheduler has a cadence baseline.
    // (MOBILE_PUSH_NOTIFICATIONS_SPEC §5 / task §3 — done centrally here so it
    // covers every workflow-creation path in approvalWorkflowService.)
    const activeIndices = computeActiveStepIndices(data?.approval_steps, data?.approval_type);
    const now = new Date();
    for (const idx of activeIndices) {
      const step = data.approval_steps[idx];
      if (step && !step.activated_at) step.activated_at = now;
    }

    const approvalRequest = new this.ApprovalRequest(data);
    const saved = await approvalRequest.save();

    // Best-effort routed push to the initial approver(s). Never blocks/throws.
    try {
      const approverIds = activeIndices
        .map((idx) => saved.approval_steps?.[idx]?.approver_user_id)
        .filter(Boolean);
      await fireRoutedApproverPush(this.ApprovalRequest.db, saved._id, saved.request_type, approverIds);
    } catch {
      // swallow — push is best-effort
    }

    return saved;
  }

  async update(id, updateData) {
    return await this.ApprovalRequest.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  /** Update with raw MongoDB operators ($set, $push, etc.) */
  async updateWithOps(id, updateObj) {
    return await this.ApprovalRequest.findByIdAndUpdate(id, updateObj, { new: true, runValidators: true });
  }

  async updateApprovalStep(requestId, stepIndex, updateData) {
    const request = await this.ApprovalRequest.findById(requestId);
    if (!request) throw new Error('Approval request not found');
    if (!request.approval_steps[stepIndex]) throw new Error('Approval step not found');

    const $set = {};
    for (const [key, value] of Object.entries(updateData)) {
      if (key === 'acknowledgement_files' && Array.isArray(value)) {
        $set[`approval_steps.${stepIndex}.${key}`] = value.map(f => ({
          name: f.name || '',
          size: f.size || 0,
          file_type: f.type || f.file_type || '',
          url: f.url || '',
          key: f.key || ''
        }));
      } else {
        $set[`approval_steps.${stepIndex}.${key}`] = value;
      }
    }

    const result = await this.ApprovalRequest.collection.updateOne(
      { _id: request._id },
      { $set }
    );
    console.log('[updateApprovalStep] Native update result:', JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount, keys: Object.keys($set) }));

    const fresh = await this.ApprovalRequest.findById(requestId);

    // When a step is approved in a sequential workflow, the next pending step
    // becomes the current one — stamp its activated_at (reminder baseline) and
    // fire a best-effort routed push. Fully guarded; never blocks the decision.
    try {
      if (updateData?.status === 'approved' && fresh && String(fresh.status) === 'pending') {
        const steps = fresh.approval_steps || [];
        const activeIndices = computeActiveStepIndices(steps, fresh.approval_type);
        const now = new Date();
        const toStamp = [];
        for (const idx of activeIndices) {
          if (!steps[idx]?.activated_at) toStamp.push(idx);
        }
        if (toStamp.length) {
          const $setActivate = {};
          for (const idx of toStamp) $setActivate[`approval_steps.${idx}.activated_at`] = now;
          await this.ApprovalRequest.collection.updateOne({ _id: fresh._id }, { $set: $setActivate });
          const approverIds = toStamp
            .map((idx) => steps[idx]?.approver_user_id)
            .filter(Boolean);
          await fireRoutedApproverPush(this.ApprovalRequest.db, fresh._id, fresh.request_type, approverIds);
        }
      }
    } catch {
      // swallow — activation/push is best-effort
    }

    return fresh;
  }

  async updateStatus(id, status, additionalData = {}) {
    const updateData = { status, ...additionalData };
    
    if (status === 'approved' || status === 'rejected' || status === 'cancelled') {
      updateData.completed_at = new Date();
    }
    
    return await this.ApprovalRequest.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.ApprovalRequest.findByIdAndDelete(id);
  }

  // Rejection Review Methods
  async createRejectionReview(requestId, rejectionReviewData) {
    const request = await this.ApprovalRequest.findById(requestId);
    if (!request) {
      throw new Error('Approval request not found');
    }
    
    request.rejection_reviews.push(rejectionReviewData);
    request.current_rejection_review_id = request.rejection_reviews[request.rejection_reviews.length - 1]._id;
    request.rejection_loop_count = (request.rejection_loop_count || 0) + 1;
    request.status = 'pending_rejection_review';
    
    return await request.save();
  }

  async updateRejectionReview(requestId, reviewId, reviewData) {
    const request = await this.ApprovalRequest.findById(requestId);
    if (!request) {
      throw new Error('Approval request not found');
    }
    
    const review = request.rejection_reviews.id(reviewId);
    if (!review) {
      throw new Error('Rejection review not found');
    }
    
    Object.assign(review, reviewData);
    return await request.save();
  }

  async findPendingEscalationsForUser(userId) {
    return await this.ApprovalRequest.find({
      status: { $in: ['pending', 'paused_for_coi', 'pending_rejection_review'] },
      escalations: {
        $elemMatch: {
          escalated_to: userId,
          status: 'pending'
        }
      }
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .populate('escalations.escalated_by', 'first_name last_name email')
      .populate('escalations.escalated_to', 'first_name last_name email')
      .sort({ created_at: -1 });
  }

  async findPendingRejectionReviews(userId) {
    return await this.ApprovalRequest.find({
      status: 'pending_rejection_review',
      'rejection_reviews': {
        $elemMatch: {
          forwarded_to: userId,
          review_status: 'pending'
        }
      }
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('rejection_reviews.rejected_by', 'first_name last_name email')
      .populate('rejection_reviews.forwarded_to', 'first_name last_name email')
      .sort({ created_at: -1 });
  }

  async getCurrentRejectionReview(requestId) {
    const request = await this.ApprovalRequest.findById(requestId)
      .populate('rejection_reviews.rejected_by', 'first_name last_name email')
      .populate('rejection_reviews.forwarded_to', 'first_name last_name email');
    
    if (!request || !request.current_rejection_review_id) {
      return null;
    }
    
    return request.rejection_reviews.id(request.current_rejection_review_id);
  }

  async getApprovalWorkflowParticipants(requestId) {
    const request = await this.ApprovalRequest.findById(requestId)
      .populate('approval_steps.approver_user_id', 'first_name last_name email');
    
    if (!request) {
      return [];
    }
    
    // Get unique participants from approval steps (exclude department head - not part of workflow)
    const participants = new Map();
    request.approval_steps.forEach(step => {
      // Skip department head approvals as they're not part of the rejection workflow
      if (step.is_department_head) {
        return;
      }
      
      if (step.approver_user_id) {
        const userId = step.approver_user_id._id || step.approver_user_id;
        const userKey = userId.toString();
        if (!participants.has(userKey)) {
          participants.set(userKey, {
            _id: userId,
            first_name: step.approver_user_id.first_name,
            last_name: step.approver_user_id.last_name,
            email: step.approver_user_id.email,
            approval_status: step.status
          });
        }
      }
    });
    
    return Array.from(participants.values());
  }
}
