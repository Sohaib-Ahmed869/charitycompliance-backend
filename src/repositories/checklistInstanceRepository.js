import checklistInstanceSchema from '../db/schemas/platform/checklistInstanceSchema.js';
import checklistTemplateSchema from '../db/schemas/platform/checklistTemplateSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import { UserRepository } from './userRepository.js';

export class ChecklistInstanceRepository {
  constructor(tenantDb) {
    tenantDb.models.ChecklistTemplate ||
      tenantDb.model('ChecklistTemplate', checklistTemplateSchema);
    tenantDb.models.ApprovalRequest ||
      tenantDb.model('ApprovalRequest', approvalRequestSchema);
    new UserRepository(tenantDb);

    this.Instance =
      tenantDb.models.ChecklistInstance ||
      tenantDb.model('ChecklistInstance', checklistInstanceSchema);
  }

  async create(data) {
    const doc = new this.Instance({ ...data, entity_type: 'instance' });
    return await doc.save();
  }

  async findById(id) {
    return await this.Instance.findOne({ _id: id, entity_type: 'instance' })
      .populate('approval_request_id')
      .populate('items.checked_by', 'first_name last_name email')
      .populate('items.evidence.uploaded_by', 'first_name last_name email')
      .populate('closed_by', 'first_name last_name email');
  }

  async findByPeriod(orgId, type, period) {
    const q = { org_id: orgId, type, entity_type: 'instance' };
    if (period?.year) q['period.year'] = period.year;
    if (period?.month) q['period.month'] = period.month;
    if (period?.quarter) q['period.quarter'] = period.quarter;
    return await this.Instance.findOne(q).sort({ createdAt: -1 });
  }

  async list(orgId, { type, year, month, quarter, status } = {}) {
    const q = { org_id: orgId, entity_type: 'instance' };
    if (type) q.type = type;
    if (status) q.status = status;
    if (year) q['period.year'] = Number(year);
    if (month) q['period.month'] = Number(month);
    if (quarter) q['period.quarter'] = Number(quarter);
    if (arguments[1]?.entityType) q['context.entityType'] = String(arguments[1].entityType);
    if (arguments[1]?.entityId) q['context.entityId'] = String(arguments[1].entityId);
    return await this.Instance.find(q).sort({ createdAt: -1 });
  }

  async findByContext(orgId, { type, entityType, entityId }) {
    const q = {
      org_id: orgId,
      entity_type: 'instance',
      'context.entityType': String(entityType),
      'context.entityId': String(entityId)
    };
    if (type) q.type = type;
    return await this.Instance.findOne(q).sort({ createdAt: -1 });
  }

  async findByApprovalRequest(orgId, approvalRequestId, { type } = {}) {
    if (!approvalRequestId) return null;
    const q = {
      org_id: orgId,
      entity_type: 'instance',
      approval_request_id: approvalRequestId
    };
    if (type) q.type = type;
    return await this.Instance.findOne(q).sort({ createdAt: -1 });
  }

  async update(id, update) {
    return await this.Instance.findOneAndUpdate(
      { _id: id, entity_type: 'instance' },
      { $set: update },
      { new: true, runValidators: true }
    );
  }

  async close(id, userId) {
    return await this.update(id, { status: 'closed', closed_at: new Date(), closed_by: userId });
  }
}

