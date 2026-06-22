/**
 * Related Party Transaction repository — per-request, tenant-bound.
 */

import relatedPartyTransactionSchema from '../db/schemas/platform/relatedPartyTransactionSchema.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';

const ensureModel = (tenantDb, name, schema) =>
  tenantDb.models[name] || tenantDb.model(name, schema);

export class RelatedPartyTransactionRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.Rpt = ensureModel(tenantDb, 'RelatedPartyTransaction', relatedPartyTransactionSchema);
    // Registered for populate of related_person/board member.
    ensureModel(tenantDb, 'BoardMember', boardMemberSchema);
  }

  async create(data) {
    const doc = new this.Rpt(data);
    return await doc.save();
  }

  async findByOrgId(orgId, { status, riskLevel, search, activeOnly = true } = {}) {
    const q = { org_id: orgId };
    if (activeOnly) q.is_active = true;
    if (status) q.status = status;
    if (riskLevel) q.risk_level = riskLevel;
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { related_party_name: rx },
        { related_person_name: rx },
        { rpt_number: rx },
        { transaction_description: rx }
      ];
    }
    return await this.Rpt.find(q)
      .populate('created_by', 'first_name last_name email')
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(id) {
    return await this.Rpt.findById(id)
      .populate('created_by', 'first_name last_name email')
      .populate('updated_by', 'first_name last_name email')
      .populate('board_approval.approved_by', 'first_name last_name email')
      .populate('supporting_documents.uploaded_by', 'first_name last_name email')
      .lean();
  }

  async findByIdMutable(id) {
    return await this.Rpt.findById(id);
  }

  async findByCoi(orgId, coiRequestId) {
    return await this.Rpt.findOne({ org_id: orgId, 'source.coi_request_id': coiRequestId }).lean();
  }

  async update(id, patch) {
    return await this.Rpt.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
  }

  async countByStatus(orgId) {
    const rows = await this.Rpt.aggregate([
      { $match: { org_id: orgId, is_active: true } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const out = { total: 0 };
    rows.forEach((r) => { out[r._id] = r.count; out.total += r.count; });
    return out;
  }

  async countHighRisk(orgId) {
    return await this.Rpt.countDocuments({ org_id: orgId, is_active: true, risk_level: 'high' });
  }

  /** Generate the next RPT number for the calendar year: RPT-<YYYY>-NNNN. */
  async nextRptNumber(orgId, year) {
    const prefix = `RPT-${year}-`;
    const last = await this.Rpt.findOne({ org_id: orgId, rpt_number: new RegExp(`^${prefix}`) })
      .sort({ rpt_number: -1 })
      .select('rpt_number')
      .lean();
    let seq = 1;
    if (last?.rpt_number) {
      const n = parseInt(String(last.rpt_number).slice(prefix.length), 10);
      if (!Number.isNaN(n)) seq = n + 1;
    }
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }
}
