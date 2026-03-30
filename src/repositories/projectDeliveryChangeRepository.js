import projectDeliveryChangeSchema from '../db/schemas/platform/projectDeliveryChangeSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';

export class ProjectDeliveryChangeRepository {
  constructor(tenantDb) {
    tenantDb.models.ProjectRegister ||
      tenantDb.model('ProjectRegister', projectRegisterSchema);
    tenantDb.models.FundingAgreement ||
      tenantDb.model('FundingAgreement', fundingAgreementSchema);
    this.ProjectDeliveryChange =
      tenantDb.models.ProjectDeliveryChange || tenantDb.model('ProjectDeliveryChange', projectDeliveryChangeSchema);
  }

  async findByOrgId(orgId, projectId) {
    const query = { org_id: orgId };
    if (projectId) query.project_id = projectId;
    return await this.ProjectDeliveryChange.find(query)
      .populate('project_id', 'project_name project_code agreement_title')
      .populate('agreement_id', 'agreement_title partner_name total_amount')
      .sort({ createdAt: -1 })
      .lean();
  }

  async findByToken(token, orgKey = null) {
    const query = { token };
    if (orgKey) query.org_key = orgKey;
    return await this.ProjectDeliveryChange.findOne(query).lean();
  }

  async findByProjectId(projectId) {
    return await this.ProjectDeliveryChange.find({ project_id: projectId }).sort({ createdAt: -1 }).lean();
  }

  async findActiveByProjectId(projectId) {
    return await this.ProjectDeliveryChange.findOne({
      project_id: projectId,
      status: { $in: ['awaiting_partner_explanation', 'partner_explanation_submitted', 'internal_approved'] }
    }).sort({ createdAt: -1 }).lean();
  }

  async create(data) {
    const doc = new this.ProjectDeliveryChange(data);
    return await doc.save();
  }

  async updateById(id, updateData) {
    return await this.ProjectDeliveryChange.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }
}

