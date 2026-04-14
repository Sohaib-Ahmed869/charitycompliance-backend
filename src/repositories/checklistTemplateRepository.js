import checklistTemplateSchema from '../db/schemas/platform/checklistTemplateSchema.js';

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ChecklistTemplateRepository {
  constructor(tenantDb) {
    this.Template =
      tenantDb.models.ChecklistTemplate ||
      tenantDb.model('ChecklistTemplate', checklistTemplateSchema);
  }

  async create(data) {
    const doc = new this.Template(data);
    return await doc.save();
  }

  async findById(id) {
    return await this.Template.findById(id);
  }

  async findActiveByType(orgId, type) {
    return await this.Template.findOne({ org_id: orgId, type, is_active: true }).sort({ createdAt: -1 });
  }

  async list(orgId, { type, module } = {}) {
    const q = { org_id: orgId };
    if (type) q.type = type;
    if (module) {
      const normalizedModule = String(module).replace(/\+/g, ' ').trim();
      q['metadata.module'] = { $regex: `^${escapeRegex(normalizedModule)}$`, $options: 'i' };
    }
    return await this.Template.find(q).sort({ createdAt: -1 });
  }

  async update(id, update) {
    return await this.Template.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
  }

  async delete(id) {
    return await this.Template.findByIdAndDelete(id);
  }
}

