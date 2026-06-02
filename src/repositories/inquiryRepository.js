/**
 * Inquiry repositories
 *
 * Per-request, tenant-bound. Both repos go in one file because they
 * share the tenant connection plumbing and are always used together
 * from the controller.
 */

import inquiryTemplateSchema from '../db/schemas/platform/inquiryTemplateSchema.js';
import inquiryRecordSchema   from '../db/schemas/platform/inquiryRecordSchema.js';
import boardMemberSchema     from '../db/schemas/platform/boardMemberSchema.js';
import positionSchema        from '../db/schemas/platform/positionSchema.js';

const ensureModel = (tenantDb, name, schema) =>
  tenantDb.models[name] || tenantDb.model(name, schema);

export class InquiryTemplateRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.Template = ensureModel(tenantDb, 'InquiryTemplate', inquiryTemplateSchema);
    // Register populate targets so the controller's .populate() calls
    // don't hit MissingSchemaError on a fresh tenant connection.
    ensureModel(tenantDb, 'BoardMember', boardMemberSchema);
    ensureModel(tenantDb, 'Position',    positionSchema);
  }

  async create(data) {
    const doc = new this.Template(data);
    return await doc.save();
  }

  async findByOrgId(orgId, { status } = {}) {
    const q = { org_id: orgId };
    if (status) q.status = status;
    return await this.Template.find(q).sort({ createdAt: -1 }).lean();
  }

  async findById(templateId) {
    return await this.Template.findById(templateId).lean();
  }

  async update(templateId, patch) {
    // Re-run validation so the "last step must be board member" hook
    // catches edits, not just creates.
    const doc = await this.Template.findById(templateId);
    if (!doc) return null;
    Object.assign(doc, patch);
    return await doc.save();
  }

  async archive(templateId) {
    return await this.Template.findByIdAndUpdate(
      templateId,
      { status: 'archived' },
      { new: true }
    );
  }

  async delete(templateId) {
    return await this.Template.findByIdAndDelete(templateId);
  }
}

export class InquiryRecordRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.Record = ensureModel(tenantDb, 'InquiryRecord', inquiryRecordSchema);
    // For populate()
    ensureModel(tenantDb, 'InquiryTemplate', inquiryTemplateSchema);
    ensureModel(tenantDb, 'BoardMember',     boardMemberSchema);
    ensureModel(tenantDb, 'Position',        positionSchema);
  }

  async create(data) {
    const doc = new this.Record(data);
    return await doc.save();
  }

  async findByOrgId(orgId, { templateId, status, parentEntityType, parentEntityId } = {}) {
    const q = { org_id: orgId };
    if (templateId)         q.template_id        = templateId;
    if (status)             q.status             = status;
    if (parentEntityType)   q.parent_entity_type = parentEntityType;
    if (parentEntityId)     q.parent_entity_id   = parentEntityId;
    return await this.Record.find(q)
      .populate('submitted_by', 'first_name last_name email')
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(recordId) {
    return await this.Record.findById(recordId)
      .populate('submitted_by', 'first_name last_name email')
      .populate('template_id', 'name parent_entity_type custom_fields workflow_steps')
      .lean();
  }

  /** Used by the approve/reject endpoints — needs a mutable doc, not lean. */
  async findByIdMutable(recordId) {
    return await this.Record.findById(recordId);
  }

  async save(doc) {
    return await doc.save();
  }

  /** Counts records per template — drives the templates list page's
   *  "records" column. Returns a Map keyed by template_id string. */
  async countByTemplate(orgId) {
    const rows = await this.Record.aggregate([
      { $match: { org_id: orgId } },
      { $group: { _id: '$template_id', count: { $sum: 1 } } }
    ]);
    const map = new Map();
    rows.forEach((r) => map.set(String(r._id), r.count));
    return map;
  }
}
