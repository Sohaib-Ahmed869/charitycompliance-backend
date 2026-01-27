/**
 * Board Member Repository
 * 
 * Manages responsible persons (board members, directors, trustees)
 */

import mongoose from 'mongoose';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';

export class BoardMemberRepository {
  constructor(tenantDb) {
    this.BoardMember = tenantDb.models.BoardMember || 
      tenantDb.model('BoardMember', boardMemberSchema);
  }

  async findByOrgId(orgId, includeInactive = false) {
    const query = { org_id: orgId };
    if (!includeInactive) {
      query.is_active = true;
    }
    return await this.BoardMember.find(query).sort({ appointment_date: -1 });
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

  async findByInvitationToken(token) {
    return await this.BoardMember.findOne({
      invitation_token: token,
      is_active: true
    });
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
