/**
 * Board Member Repository
 * 
 * Manages responsible persons (board members, directors, trustees)
 */

import mongoose from 'mongoose';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import positionSchema from '../db/schemas/platform/positionSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';

export class BoardMemberRepository {
  constructor(tenantDb) {
    // Register Position and Department so populate() works on tenant connection
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    this.BoardMember = tenantDb.models.BoardMember ||
      tenantDb.model('BoardMember', boardMemberSchema);
  }

  async findByOrgId(orgId, includeInactive = false, populatePosition = false) {
    const query = { org_id: orgId };
    if (!includeInactive) {
      query.is_active = true;
    }
    let q = this.BoardMember.find(query).sort({ appointment_date: -1 });
    if (populatePosition) {
      q = q.populate({ path: 'position_id', populate: { path: 'department_id' } });
    }
    return await q;
  }

  async findById(id) {
    return await this.BoardMember.findById(id);
  }

  async findByEmail(email, orgId) {
    return await this.BoardMember.findOne({ 
      email, 
      org_id: orgId,
      is_active: true 
    });
  }

  async create(data) {
    const boardMember = new this.BoardMember(data);
    return await boardMember.save();
  }

  async update(id, data) {
    return await this.BoardMember.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true }
    );
  }

  async delete(id) {
    return await this.BoardMember.findByIdAndUpdate(
      id,
      { $set: { is_active: false, status: 'removed' } },
      { new: true }
    );
  }

  async countByOrgId(orgId) {
    return await this.BoardMember.countDocuments({ 
      org_id: orgId, 
      is_active: true 
    });
  }

  async hasPosition(orgId, position) {
    return await this.BoardMember.findOne({
      org_id: orgId,
      position,
      is_active: true
    });
  }

  async findByUserId(userId, orgId) {
    return await this.BoardMember.findOne({
      user_id: userId,
      org_id: orgId,
      is_active: true
    });
  }

  async findByInvitationToken(token) {
    return await this.BoardMember.findOne({
      invitation_token: token,
      is_active: true
    });
  }

  /** Find the head of department for a given department (board member with is_head_of_department and position in that department) */
  async findDepartmentHeadByDepartmentId(orgId, departmentId) {
    if (!departmentId) return null;
    const boardMembers = await this.BoardMember.find({
      org_id: orgId,
      is_active: true,
      is_head_of_department: true,
      position_id: { $ne: null }
    })
      .populate('position_id')
      .lean();
    const departmentIdStr = departmentId.toString();
    return boardMembers.find(
      (bm) => bm.position_id && bm.position_id.department_id && bm.position_id.department_id.toString() === departmentIdStr
    ) || null;
  }

  async updateInvitationStatus(id, status, additionalData = {}) {
    return await this.BoardMember.findByIdAndUpdate(
      id,
      {
        $set: {
          invitation_status: status,
          ...additionalData
        }
      },
      { new: true }
    );
  }
}
