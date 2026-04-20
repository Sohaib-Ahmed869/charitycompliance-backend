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
    const doc = new this.Template({ ...data, entity_type: 'template' });
    return await doc.save();
  }

  async findById(id) {
    return await this.Template.findOne({ _id: id, entity_type: 'template' });
  }

  async findActiveByType(orgId, type) {
    return await this.Template.findOne({ org_id: orgId, type, is_active: true, entity_type: 'template' }).sort({ createdAt: -1 });
  }

  async list(orgId, { type, module } = {}) {
    const q = { org_id: orgId, entity_type: 'template' };
    if (type) q.type = type;
    if (module) {
      const normalizedModule = String(module).replace(/\+/g, ' ').trim();
      q['metadata.module'] = { $regex: `^${escapeRegex(normalizedModule)}$`, $options: 'i' };
    }
    return await this.Template.find(q).sort({ createdAt: -1 });
  }

  async update(id, update) {
    return await this.Template.findOneAndUpdate(
      { _id: id, entity_type: 'template' },
      { $set: update },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.Template.findOneAndDelete({ _id: id, entity_type: 'template' });
  }
}

