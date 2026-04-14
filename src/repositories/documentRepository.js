/**
 * Document Repository
 * 
 * Manages document uploads and metadata
 */

import mongoose from 'mongoose';
import documentSchema from '../db/schemas/platform/documentSchema.js';

export class DocumentRepository {
  constructor(tenantDb) {
    this.Document = tenantDb.models.Document || 
      tenantDb.model('Document', documentSchema);
  }

  async findByOrgId(orgId, category = null) {
    const query = { org_id: orgId };
    if (category) {
      query.category = category;
    }
    return await this.Document.find(query).sort({ createdAt: -1 });
  }

  async findById(id) {
    return await this.Document.findById(id);
  }

  async create(data) {
    const document = new this.Document(data);
    return await document.save();
  }

  async update(id, data) {
    return await this.Document.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true }
    );
  }

  async delete(id) {
    return await this.Document.findByIdAndDelete(id);
  }

  async findByCategory(orgId, category) {
    return await this.Document.find({
      org_id: orgId,
      category
    }).sort({ createdAt: -1 });
  }

  /** Blocks duplicate upload while a fiscal report for the same period is in flight or approved. */
  async findBlockingFiscalReport(orgObjectId, periodKey) {
    if (!periodKey) return null;
    return await this.Document.findOne({
      org_id: orgObjectId,
      category: 'fiscal_report',
      'metadata.period_key': String(periodKey),
      status: { $in: ['submitted', 'review_pending', 'approved', 'resubmission_required'] }
    }).lean();
  }

  /** Any BAS period document for this quarter key (shell or lodged). */
  async findBasPeriodByKey(orgObjectId, periodKey) {
    if (!periodKey) return null;
    return await this.Document.findOne({
      org_id: orgObjectId,
      category: 'bas_lodgement',
      'metadata.period_key': String(periodKey)
    }).lean();
  }

  async findVersions(parentDocumentId) {
    return await this.Document.find({
      parent_document_id: parentDocumentId
    }).sort({ version: -1 });
  }

  async createVersion(parentDocumentId, data) {
    const parent = await this.findById(parentDocumentId);
    if (!parent) {
      throw new Error('Parent document not found');
    }

    const version = new this.Document({
      ...data,
      parent_document_id: parentDocumentId,
      version: parent.version + 1,
      org_id: parent.org_id
    });

    return await version.save();
  }
}
