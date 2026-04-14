/**
 * Board Member Repository
 * 
 * Manages responsible persons (board members, directors, trustees)
 */

import mongoose from 'mongoose';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import positionSchema from '../db/schemas/platform/positionSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';
import { UserRepository } from './userRepository.js';

export class BoardMemberRepository {
  constructor(tenantDb) {
    // Register Position and Department so populate() works on tenant connection
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    this.BoardMember = tenantDb.models.BoardMember ||
      tenantDb.model('BoardMember', boardMemberSchema);
    this._userRepo = new UserRepository(tenantDb);
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

  async findByIdWithRelations(id) {
    return await this.BoardMember.findById(id)
      .populate({ path: 'position_id', populate: { path: 'department_id' } });
  }

  /**
   * Find an active board member in this org with the same email (case-insensitive).
   * Uses email_hash (same algorithm as User) so encrypted emails are matchable.
   * @param {string} excludeBoardMemberId - When updating, exclude this record from the search
   */
  async findActiveByEmailInOrg(email, orgId, excludeBoardMemberId = null) {
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized) return null;
    const hash = this._userRepo.createEmailHash(normalized);
    const query = {
      org_id: orgId,
      email_hash: hash,
      is_active: true
    };
    if (excludeBoardMemberId) {
      query._id = { $ne: new mongoose.Types.ObjectId(String(excludeBoardMemberId)) };
    }
    return await this.BoardMember.findOne(query);
  }

  /** @deprecated Use findActiveByEmailInOrg — plaintext email query does not work with encryption */
  async findByEmail(email, orgId) {
    return await this.findActiveByEmailInOrg(email, orgId);
  }

  async create(data) {
    const boardMember = new this.BoardMember(data);
    return await boardMember.save();
  }

  async update(id, data) {
    if (data && Object.prototype.hasOwnProperty.call(data, 'email')) {
      const doc = await this.BoardMember.findById(id);
      if (!doc) return null;
      for (const key of Object.keys(data)) {
        doc.set(key, data[key]);
      }
      await doc.save();
      return await this.BoardMember.findById(id);
    }
    return await this.BoardMember.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true }
    );
  }

  async delete(id, extraFields = {}) {
    return await this.BoardMember.findByIdAndUpdate(
      id,
      { $set: { is_active: false, status: 'removed', ...extraFields } },
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

  async findActiveByEffectivePositionInOrg(orgId, effectivePosition, excludeBoardMemberId = null) {
    const normalized = String(effectivePosition || '').trim().toLowerCase();
    if (!normalized) return null;
    const query = { org_id: orgId, is_active: true };
    if (excludeBoardMemberId) {
      query._id = { $ne: new mongoose.Types.ObjectId(String(excludeBoardMemberId)) };
    }
    const members = await this.BoardMember.find(query)
      .select({ position: 1, custom_position_title: 1, is_volunteer: 1 })
      .lean();
    return (
      members.find((m) => {
        if (m?.is_volunteer) return false;
        const label = String(m?.custom_position_title || m?.position || '').trim().toLowerCase();
        return !!label && label === normalized;
      }) || null
    );
  }

  async findByUserId(userId, orgId) {
    return await this.BoardMember.findOne({
      user_id: userId,
      org_id: orgId,
      is_active: true
    });
  }

  async findAllActiveByUserId(userId, orgId) {
    return await this.BoardMember.find({
      user_id: userId,
      org_id: orgId,
      is_active: true
    }).lean();
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

  async findActiveDepartmentHead(orgId, { departmentId = null, departmentName = null, excludeBoardMemberId = null } = {}) {
    if (!orgId) return null;

    // Prefer departmentId (canonical), fall back to departmentName (string on BoardMember)
    if (departmentId) {
      const Position = this.BoardMember.db.models.Position;
      const positions = await Position.find({
        org_id: orgId,
        department_id: departmentId,
        is_active: true
      }).select({ _id: 1 }).lean();
      const positionIds = positions.map((p) => p._id).filter(Boolean);
      if (positionIds.length) {
        const q = {
          org_id: orgId,
          is_active: true,
          is_head_of_department: true,
          position_id: { $in: positionIds },
        };
        if (excludeBoardMemberId) q._id = { $ne: new mongoose.Types.ObjectId(String(excludeBoardMemberId)) };
        const bm = await this.BoardMember.findOne(q).lean();
        if (bm) return bm;
      }
    }

    const name = String(departmentName || '').trim();
    if (name) {
      const q = {
        org_id: orgId,
        is_active: true,
        is_head_of_department: true,
        department: name
      };
      if (excludeBoardMemberId) q._id = { $ne: new mongoose.Types.ObjectId(String(excludeBoardMemberId)) };
      return await this.BoardMember.findOne(q).lean();
    }
    return null;
  }

  /**
   * Ensure only one active head of department exists per department.
   * When assigning a head, clear the flag from other active members in the same department.
   */
  async clearOtherDepartmentHeads(orgId, departmentId, excludeBoardMemberId) {
    if (!orgId || !departmentId) return { modifiedCount: 0 };
    const Position = this.BoardMember.db.models.Position;
    const positions = await Position.find({
      org_id: orgId,
      department_id: departmentId,
      is_active: true
    }).select({ _id: 1 }).lean();
    const positionIds = positions.map((p) => p._id).filter(Boolean);
    if (positionIds.length === 0) return { modifiedCount: 0 };

    const query = {
      org_id: orgId,
      is_active: true,
      is_head_of_department: true,
      position_id: { $in: positionIds },
    };
    if (excludeBoardMemberId) {
      query._id = { $ne: new mongoose.Types.ObjectId(String(excludeBoardMemberId)) };
    }
    const res = await this.BoardMember.updateMany(query, { $set: { is_head_of_department: false } });
    return { modifiedCount: res?.modifiedCount ?? 0 };
  }
}
