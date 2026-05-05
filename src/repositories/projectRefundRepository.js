import projectRefundSchema from '../db/schemas/platform/projectRefundSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';

const _repairedDbs = new WeakSet();

export class ProjectRefundRepository {
  constructor(tenantDb) {
    tenantDb.models.ProjectRegister ||
      tenantDb.model('ProjectRegister', projectRegisterSchema);
    tenantDb.models.FundingAgreement ||
      tenantDb.model('FundingAgreement', fundingAgreementSchema);
    this.ProjectRefund = tenantDb.models.ProjectRefund || tenantDb.model('ProjectRefund', projectRefundSchema);
    this._tenantDb = tenantDb;

    if (!_repairedDbs.has(tenantDb)) {
      _repairedDbs.add(tenantDb);
      this._repairPromise = this._dropLegacyPaymentAckTokenIndex().catch(() => {});
    }
  }

  /**
   * Drop the legacy unique compound index on (org_key, payment_ack_token).
   * project_refunds never had a payment_ack_token field — that index was
   * created by an earlier deployment that copied donorRefundSchema, and it
   * blocks every second insert because both rows have payment_ack_token=null.
   */
  async _dropLegacyPaymentAckTokenIndex() {
    try {
      await this._tenantDb.collection('project_refunds').dropIndex('org_key_1_payment_ack_token_1');
    } catch (_) { /* already gone */ }
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
    if (this._repairPromise) await this._repairPromise;
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

