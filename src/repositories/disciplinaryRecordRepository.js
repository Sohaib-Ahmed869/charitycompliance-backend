import disciplinaryRecordSchema from '../db/schemas/platform/disciplinaryRecordSchema.js';

export class DisciplinaryRecordRepository {
  constructor(tenantDb) {
    this.DisciplinaryRecord =
      tenantDb.models.DisciplinaryRecord ||
      tenantDb.model('DisciplinaryRecord', disciplinaryRecordSchema);
  }

  async create(data) {
    const doc = new this.DisciplinaryRecord(data);
    return doc.save();
  }

  async update(id, updateData) {
    return this.DisciplinaryRecord.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async findById(id) {
    return this.DisciplinaryRecord.findById(id)
      .populate('staff_member_id', 'first_name last_name email position')
      .populate('created_by_user_id', 'first_name last_name email')
      .lean();
  }

  async findByOrg(orgId, filters = {}) {
    const query = { org_id: orgId };
    if (filters.status) query.status = filters.status;
    if (filters.search) {
      const regex = new RegExp(filters.search, 'i');
      query.$or = [
        { issue_type: regex },
        { description: regex },
        { staff_name_snapshot: regex }
      ];
    }

    return this.DisciplinaryRecord.find(query)
      .sort({ createdAt: -1 })
      .populate('staff_member_id', 'first_name last_name email position')
      .populate('created_by_user_id', 'first_name last_name email')
      .lean();
  }
}

