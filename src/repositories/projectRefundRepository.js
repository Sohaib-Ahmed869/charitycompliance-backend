import projectRefundSchema from '../db/schemas/platform/projectRefundSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';

export class ProjectRefundRepository {
  constructor(tenantDb) {
    tenantDb.models.ProjectRegister ||
      tenantDb.model('ProjectRegister', projectRegisterSchema);
    tenantDb.models.FundingAgreement ||
      tenantDb.model('FundingAgreement', fundingAgreementSchema);
    this.ProjectRefund = tenantDb.models.ProjectRefund || tenantDb.model('ProjectRefund', projectRefundSchema);
  }

  async findByOrgId(orgId, projectId) {
    const query = { org_id: orgId };
    if (projectId) query.project_id = projectId;
    return await this.ProjectRefund.find(query)
      .populate('project_id', 'project_name project_code agreement_title')
      .populate('agreement_id', 'agreement_title partner_name total_amount')
      .sort({ createdAt: -1 })
      .lean();
  }

  async findByToken(token, orgKey = null) {
    const query = { token };
    if (orgKey) query.org_key = orgKey;
    return await this.ProjectRefund.findOne(query).lean();
  }

  async findByProjectId(projectId) {
    return await this.ProjectRefund.find({ project_id: projectId }).sort({ createdAt: -1 }).lean();
  }

  async findActiveByProjectId(projectId) {
    return await this.ProjectRefund.findOne({
      project_id: projectId,
      status: { $in: ['pending_initiation', 'awaiting_partner_receipts', 'partner_receipts_submitted', 'internal_approved'] }
    }).sort({ createdAt: -1 }).lean();
  }

  async create(data) {
    const doc = new this.ProjectRefund(data);
    return await doc.save();
  }

  async updateById(id, updateData) {
    return await this.ProjectRefund.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }
}

