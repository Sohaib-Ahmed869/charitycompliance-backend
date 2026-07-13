/**
 * Legal Document Repository
 * 
 * Manages legal document data operations
 */

import legalDocumentSchema from '../db/schemas/platform/legalDocumentSchema.js';
import { UserRepository } from './userRepository.js';
import { escapeRegex } from '../utils/escapeRegex.js';

export class LegalDocumentRepository {
  constructor(tenantDb) {
    new UserRepository(tenantDb);

    this.LegalDocument = tenantDb.models.LegalDocument ||
      tenantDb.model('LegalDocument', legalDocumentSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.category) {
      query.category = filters.category;
    }
    if (filters.contract_subtype) {
      query['contract_details.subtype'] = filters.contract_subtype;
    }

    if (filters.search) {
      query.document_name = { $regex: escapeRegex(filters.search), $options: 'i' };
    }

    return await this.LegalDocument.find(query)
      .populate('owner_id', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email')
      .populate('versions.uploaded_by', 'first_name last_name email')
      .sort({ createdAt: -1 });
  }

  async findById(id) {
    return await this.LegalDocument.findById(id)
      .populate('owner_id', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email')
      .populate('versions.uploaded_by', 'first_name last_name email');
  }

  async create(data) {
    const doc = new this.LegalDocument(data);
    return await doc.save();
  }

  async update(id, updateData) {
    return await this.LegalDocument.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('owner_id', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email')
      .populate('versions.uploaded_by', 'first_name last_name email');
  }

  async archive(id) {
    return await this.LegalDocument.findByIdAndUpdate(
      id,
      { status: 'archived' },
      { new: true, runValidators: true }
    )
      .populate('owner_id', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email');
  }

  async addVersion(id, versionData) {
    const doc = await this.LegalDocument.findById(id);
    if (!doc) return null;

    const nextVersion = (doc.current_version || doc.versions.length) + 1;
    versionData.version_number = nextVersion;

    doc.versions.push(versionData);
    doc.current_version = nextVersion;
    await doc.save();

    return await this.findById(id);
  }

  async getStats(orgId) {
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const stats = await this.LegalDocument.aggregate([
      { $match: { org_id: orgId } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          active: [
            { $match: { status: 'active' } },
            { $count: 'count' }
          ],
          expired: [
            { $match: { status: 'expired' } },
            { $count: 'count' }
          ],
          archived: [
            { $match: { status: 'archived' } },
            { $count: 'count' }
          ],
          expiringSoon: [
            {
              $match: {
                status: 'active',
                expiry_date: { $lte: thirtyDaysFromNow, $gte: now }
              }
            },
            { $count: 'count' }
          ]
        }
      }
    ]);

    return {
      total: stats[0].total[0]?.count || 0,
      active: stats[0].active[0]?.count || 0,
      expired: stats[0].expired[0]?.count || 0,
      archived: stats[0].archived[0]?.count || 0,
      expiringSoon: stats[0].expiringSoon[0]?.count || 0
    };
  }

  async delete(id) {
    return await this.LegalDocument.findByIdAndDelete(id);
  }
}
