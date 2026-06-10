/**
 * Member Repository
 *
 * Per-request, tenant-bound. Construct with `new MemberRepository(req.tenantDb)`
 * so the model is bound to the right tenant database.
 */

import memberSchema from '../db/schemas/platform/memberSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';

export class MemberRepository {
  constructor(tenantDb) {
    this.Member = tenantDb.models.Member
      || tenantDb.model('Member', memberSchema);
    // Ensure populate('approval_request_id') resolves on the same connection.
    if (!tenantDb.models.ApprovalRequest) {
      tenantDb.model('ApprovalRequest', approvalRequestSchema);
    }
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    if (filters.status) query.status = filters.status;
    if (filters.membership_type) query.membership_type = filters.membership_type;
    if (typeof filters.is_active === 'boolean') query.is_active = filters.is_active;

    if (filters.search) {
      // full_name is plaintext; email/phone are encrypted (not regex-searchable).
      const re = new RegExp(String(filters.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { full_name: re },
        { member_number: re }
      ];
    }

    return this.Member.find(query).sort({ createdAt: -1 });
  }

  async findById(id) {
    return this.Member.findById(id);
  }

  async findByIdWithWorkflow(id) {
    return this.Member.findById(id).populate('approval_request_id');
  }

  async create(data) {
    const member = new this.Member(data);
    return member.save();
  }

  async update(id, updateData) {
    return this.Member.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return this.Member.findByIdAndDelete(id);
  }

  async getCountsByOrg(orgId) {
    const all = await this.Member.find({ org_id: orgId })
      .select('status is_active')
      .lean();
    return {
      total: all.length,
      active: all.filter((m) => m.is_active && m.status === 'approved').length,
      pending: all.filter((m) => m.status === 'pending_approval').length,
      rejected: all.filter((m) => m.status === 'rejected').length,
      inactive: all.filter((m) => !m.is_active).length
    };
  }

  /**
   * Generate the next member_number for an org. Pattern: MEM-<YYYY>-<4-digit>.
   * Sequence is per-year, scoped to the org. Safe under low concurrency.
   */
  async nextMemberNumber(orgId) {
    const year = new Date().getFullYear();
    const prefix = `MEM-${year}-`;
    const latest = await this.Member.find({
      org_id: orgId,
      member_number: new RegExp(`^${prefix}`)
    })
      .select('member_number')
      .sort({ member_number: -1 })
      .limit(1)
      .lean();
    const latestSeq = latest[0]
      ? parseInt(String(latest[0].member_number).split('-').pop(), 10) || 0
      : 0;
    const next = (latestSeq + 1).toString().padStart(4, '0');
    return `${prefix}${next}`;
  }
}
