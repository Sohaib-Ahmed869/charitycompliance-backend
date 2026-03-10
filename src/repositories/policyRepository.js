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
    
    // Handle special 'pending_review' filter
    if (filters.status === 'pending_review') {
      // Pending review: review_date is today or in the past, status is not expired
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      query.review_date = { $lte: today };
      query.status = { $ne: 'expired' };
    } else if (filters.status) {
      query.status = filters.status;
    }
    
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
    // Separate MongoDB operators from regular fields
    const operators = {};
    const setData = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('$')) {
        // MongoDB operator like $push, $inc, etc.
        operators[key] = value;
      } else {
        // Regular field to $set
        setData[key] = value;
      }
    }
    
    // Build the update object
    const updateObj = Object.keys(setData).length > 0 ? { $set: setData } : {};
    Object.assign(updateObj, operators);
    
    return this.Policy.findByIdAndUpdate(id, updateObj, { new: true });
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
      .lean();
  }

  async getCounts(orgId) {
    const [total, draft, active, underReview, expired, resubmissionRequired] = await Promise.all([
      this.Policy.countDocuments({ org_id: orgId }),
      this.Policy.countDocuments({ org_id: orgId, status: 'draft' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'active' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'under_review' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'expired' }),
      this.Policy.countDocuments({ org_id: orgId, status: 'resubmission_required' })
    ]);
    return { total, draft, active, underReview, expired, resubmissionRequired };
  }

  async getApprovals(policyId) {
    const policy = await this.Policy.findById(policyId).lean();
    
    if (!policy || !policy.review_history) {
      return [];
    }

    // Transform review_history into approval format
    return policy.review_history.map((review, index) => ({
      step: index + 1,
      reviewer_id: review.reviewed_by,
      approver_name: review.reviewed_by_name || review.approver_name || 'Reviewer', // Use stored denormalized name
      status: review.action === 'approved_no_changes' || review.action === 'updated' ? 'approved' : review.action === 'rejected' ? 'rejected' : 'pending',
      reviewed_at: review.reviewed_at,
      action: review.action,
      comments: review.comments,
      version_reviewed: review.version_reviewed
    }));
  }
}

