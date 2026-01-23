/**
 * Approval Request Repository
 * 
 * Manages approval request data operations
 */

import mongoose from 'mongoose';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';

export class ApprovalRequestRepository {
  constructor(tenantDb) {
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
      .populate('submitted_by', 'first_name last_name email')
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

  async findPendingByApprover(userId) {
    return await this.ApprovalRequest.find({
      'approval_steps.approver_user_id': userId,
      'approval_steps.status': 'pending',
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
