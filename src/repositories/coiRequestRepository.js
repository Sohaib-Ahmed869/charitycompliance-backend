/**
 * COI Request Repository
 * 
 * Manages COI request data operations
 */

import coiRequestSchema from '../db/schemas/platform/coiRequestSchema.js';
import positionSchema from '../db/schemas/platform/positionSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';
import { UserRepository } from './userRepository.js';

export class CoiRequestRepository {
  constructor(tenantDb) {
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);

    new UserRepository(tenantDb);

    this.CoiRequest = tenantDb.models.CoiRequest ||
      tenantDb.model('CoiRequest', coiRequestSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    return await this.CoiRequest.find(query)
      .populate('submitted_by', 'first_name last_name email is_org_owner')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.CoiRequest.findById(id)
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name');
  }

  async findPendingByApprover(userId, positionIds = []) {
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

    return await this.CoiRequest.find({
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
    const request = new this.CoiRequest(data);
    return await request.save();
  }

  async update(id, updateData) {
    return await this.CoiRequest.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async updateApprovalStep(requestId, stepIndex, updateData) {
    const request = await this.CoiRequest.findById(requestId);
    if (!request) {
      throw new Error('COI request not found');
    }

    if (request.approval_steps[stepIndex]) {
      Object.assign(request.approval_steps[stepIndex], updateData);
      return await request.save();
    }

    throw new Error('COI approval step not found');
  }

  async updateStatus(id, status, additionalData = {}) {
    const updateData = { status, ...additionalData };

    if (status === 'approved' || status === 'rejected' || status === 'cancelled') {
      updateData.completed_at = new Date();
    }

    return await this.CoiRequest.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }
}
