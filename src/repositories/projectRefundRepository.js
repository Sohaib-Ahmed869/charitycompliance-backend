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
      this._repairPromise = this._repairPaymentAckTokenIndex().catch(() => {});
    }
  }

  /**
   * Repair the (org_key, payment_ack_token) index on the shared
   * `project_refunds` collection. Donor refunds (donorRefundSchema) legitimately
   * need this index, but older deployments created it as a plain `unique`
   * (or `unique + sparse`) index, which collides on every { org_key, null }
   * row. Drop the stale index and recreate it as a PARTIAL index: project
   * refunds have no payment_ack_token field so they're simply not covered,
   * while donor refunds get correct uniqueness on real string tokens.
   *
   * Both refund repos run this identical, idempotent repair so — sharing one
   * collection — they converge on the correct index instead of fighting.
   */
  async _repairPaymentAckTokenIndex() {
    const coll = this._tenantDb.collection('project_refunds');
    try {
      await coll.dropIndex('org_key_1_payment_ack_token_1');
    } catch (_) { /* not present — nothing to drop */ }
    try {
      await coll.createIndex(
        { org_key: 1, payment_ack_token: 1 },
        {
          name: 'org_key_1_payment_ack_token_1',
          unique: true,
          partialFilterExpression: { payment_ack_token: { $type: 'string' } }
        }
      );
    } catch (_) { /* already in the correct shape */ }
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

