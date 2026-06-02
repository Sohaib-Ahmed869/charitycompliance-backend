/**
 * Risk Repository
 *
 * Manages risk data operations
 */

import riskSchema from '../db/schemas/platform/riskSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';
import positionSchema from '../db/schemas/platform/positionSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';
import { UserRepository } from './userRepository.js';

export class RiskRepository {
  constructor(tenantDb) {
    // Ensure related models used in populate() are registered on this tenant connection
    tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
    tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
    tenantDb.models.Position || tenantDb.model('Position', positionSchema);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    
    // Register User model for approval request populate() operations
    new UserRepository(tenantDb);

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

  /**
   * Batch lookup used by the "attached risks" panel on the approval
   * detail page. Preserves the original id order so the UI can render
   * the list in the order they were attached.
   */
  async findByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const docs = await this.Risk.find({ _id: { $in: ids } })
      .populate('risk_owner_id', 'first_name last_name email')
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_request_id', 'status workflow_stage')
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return ids
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
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

  /** Add a treatment to a risk (status defaults to 'resolved') */
  async addTreatment(riskId, treatment) {
    const t = {
      control_action: treatment.control_action || '',
      owner: treatment.owner || '',
      due_date: treatment.due_date ? new Date(treatment.due_date) : undefined,
      status: treatment.status || 'resolved',
      evidence: []
    };
    return await this.Risk.findByIdAndUpdate(
      riskId,
      { $push: { treatments: t }, $set: { updated_at: new Date() } },
      { new: true, runValidators: true }
    );
  }

  /** Add attachment to a risk */
  async addAttachment(riskId, attachment) {
    const ev = {
      file_path: attachment.file_path,
      file_name: attachment.file_name,
      file_size: attachment.file_size,
      mime_type: attachment.mime_type,
      uploaded_at: new Date()
    };
    await this.Risk.findByIdAndUpdate(
      riskId,
      { $push: { attachments: ev }, $set: { updated_at: new Date() } },
      { new: true }
    );
    return await this.findById(riskId);
  }

  /** Add evidence to a treatment */
  async addEvidenceToTreatment(riskId, treatmentIndex, evidence) {
    const risk = await this.Risk.findById(riskId);
    if (!risk || !risk.treatments?.[treatmentIndex]) return null;
    const ev = {
      file_path: evidence.file_path,
      file_name: evidence.file_name,
      file_size: evidence.file_size,
      mime_type: evidence.mime_type,
      uploaded_at: new Date()
    };
    const key = `treatments.${treatmentIndex}.evidence`;
    await this.Risk.findByIdAndUpdate(
      riskId,
      { $push: { [key]: ev }, $set: { updated_at: new Date() } },
      { new: true }
    );
    return await this.findById(riskId);
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
    // Fall back to residual_risk_level when inherent isn't set, so resolved or
    // newly-treated risks still slot into a severity bucket on the dashboard.
    const sevOf = (r) => r.inherent_risk_level || r.residual_risk_level || null;
    const byStatus = {};
    for (const r of risks) {
      const k = r.status || 'unknown';
      byStatus[k] = (byStatus[k] || 0) + 1;
    }
    return {
      total: risks.length,
      highExtreme,
      underTreatment,
      overdueReview,
      resolved: risks.filter(r => r.status === 'resolved').length,
      closed: risks.filter(r => r.status === 'closed').length,
      byStatus,
      bySeverity: {
        critical: risks.filter(r => sevOf(r) === 'critical').length,
        extreme: risks.filter(r => sevOf(r) === 'extreme').length,
        high: risks.filter(r => sevOf(r) === 'high').length,
        moderate: risks.filter(r => sevOf(r) === 'moderate').length,
        low: risks.filter(r => sevOf(r) === 'low').length
      }
    };
  }
}
