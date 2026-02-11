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
import { UserRepository } from './userRepository.js';

export class ApprovalRequestRepository {
  constructor(tenantDb) {
    // Ensure related models are registered on this tenant connection so populate() works
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
    
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
      .populate('approval_steps.approver_department_id', 'name');
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

    return await this.ApprovalRequest.find({
      $or: orConditions,
      status: 'pending'
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
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

  async updateApprovalStep(requestId, stepIndex, updateData) {
    const request = await this.ApprovalRequest.findById(requestId);
    if (!request) {
      throw new Error('Approval request not found');
    }
    
    if (request.approval_steps[stepIndex]) {
      Object.assign(request.approval_steps[stepIndex], updateData);
      return await request.save();
    }
    
    throw new Error('Approval step not found');
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
}
