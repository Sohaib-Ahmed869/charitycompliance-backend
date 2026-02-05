/**
 * Risk Repository
 *
 * Manages risk data operations
 */

import riskSchema from '../db/schemas/platform/riskSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';

export class RiskRepository {
  constructor(tenantDb) {
    // Ensure related models used in populate() are registered on this tenant connection
    tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
    tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);

    this.Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.category) {
      query.category = new RegExp(filters.category, 'i');
    }
    if (filters.search) {
      query.$or = [
        { title: new RegExp(filters.search, 'i') },
        { description: new RegExp(filters.search, 'i') }
      ];
    }

    return await this.Risk.find(query)
      .populate('risk_owner_id', 'first_name last_name email')
      .populate('risk_owner_board_member_id', 'given_names family_name email user_id')
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_request_id')
      .sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.Risk.findById(id)
      .populate('risk_owner_id', 'first_name last_name email')
      .populate('risk_owner_board_member_id', 'given_names family_name email user_id')
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id');
  }

  async create(data) {
    const risk = new this.Risk(data);
    return await risk.save();
  }

  async update(id, updateData) {
    updateData.updated_at = new Date();
    return await this.Risk.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async updateStatus(id, status, additionalData = {}) {
    const updateData = { status, updated_at: new Date(), ...additionalData };
    return await this.Risk.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.Risk.findByIdAndDelete(id);
  }

  async findByApprovalRequestId(approvalRequestId) {
    return await this.Risk.findOne({ approval_request_id: approvalRequestId })
      .populate('risk_owner_id', 'first_name last_name email')
      .populate('risk_owner_board_member_id', 'given_names family_name email user_id')
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id');
  }

  /** Aggregate counts for dashboard */
  async getCountsByOrg(orgId) {
    const risks = await this.Risk.find({ org_id: orgId });
    const highExtreme = risks.filter(
      r => ['high', 'extreme', 'critical'].includes(r.inherent_risk_level) || ['high', 'extreme', 'critical'].includes(r.residual_risk_level)
    ).length;
    const underTreatment = risks.filter(r => r.status === 'under_treatment').length;
    const overdueReview = risks.filter(
      r => r.next_review_date && new Date(r.next_review_date) < new Date() && !['closed', 'rejected'].includes(r.status)
    ).length;
    return {
      total: risks.length,
      highExtreme,
      underTreatment,
      overdueReview,
      bySeverity: {
        critical: risks.filter(r => r.inherent_risk_level === 'critical').length,
        extreme: risks.filter(r => r.inherent_risk_level === 'extreme').length,
        high: risks.filter(r => r.inherent_risk_level === 'high').length,
        moderate: risks.filter(r => r.inherent_risk_level === 'moderate').length,
        low: risks.filter(r => r.inherent_risk_level === 'low').length
      }
    };
  }
}
