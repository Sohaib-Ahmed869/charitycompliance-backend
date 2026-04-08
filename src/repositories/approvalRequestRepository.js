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

  async findPendingByApprover(userId, positionIds = []) {
    // Build query: match by user_id OR by position_id (position holders can always approve)
    // Use $elemMatch to ensure all conditions apply to the SAME array element
    const orConditions = [
      {
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
    const approvalRequest = new this.ApprovalRequest(data);
    return await approvalRequest.save();
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

    return await this.ApprovalRequest.findById(requestId);
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
