/**
 * Policy Repository
 */

import policySchema from '../db/schemas/platform/policySchema.js';
import policyDocumentLogSchema from '../db/schemas/platform/policyDocumentLogSchema.js';

/** Parse version string "v1.0" and return next version "v2.0" */
export function incrementVersion(version) {
  const match = (version || 'v1.0').match(/^v?(\d+)\.(\d+)$/i);
  if (match) {
    const minor = parseInt(match[2], 10) + 1;
    return `v${match[1]}.${minor}`;
  }
  return 'v2.0';
}

export class PolicyRepository {
  constructor(tenantDb) {
    this.Policy = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
    this.PolicyDocumentLog = tenantDb.models.PolicyDocumentLog || tenantDb.model('PolicyDocumentLog', policyDocumentLogSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    if (filters.status) query.status = filters.status;
    if (filters.category) query.category = filters.category;
    if (filters.search) {
      query.$or = [
        { title: { $regex: filters.search, $options: 'i' } },
        { description: { $regex: filters.search, $options: 'i' } }
      ];
    }
    return this.Policy.find(query).sort({ createdAt: -1 }).lean();
  }

  async findById(id) {
    return this.Policy.findById(id);
  }

  async create(data) {
    const policy = new this.Policy(data);
    return policy.save();
  }

  async update(id, data) {
    return this.Policy.findByIdAndUpdate(id, { $set: data }, { new: true });
  }

  async delete(id) {
    const result = await this.Policy.findByIdAndDelete(id);
    return !!result;
  }

  async addDocumentLog(data) {
    const log = new this.PolicyDocumentLog(data);
    return log.save();
  }

  async getDocumentLogs(policyId) {
    return this.PolicyDocumentLog.find({ policy_id: policyId })
      .sort({ createdAt: -1 })
      .populate('updated_by', 'first_name last_name email given_names family_name')
      .lean();
  }

  async getCounts(orgId) {
    const [total, draft, active, underReview, expired] = await Promise.all([
      this.Policy.countDocuments({ org_id: orgId }),
      this.Policy.countDocuments({ org_id: orgId, status: 'draft' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'active' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'under_review' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'expired' })
    ]);
    return { total, draft, active, underReview, expired };
  }
}
