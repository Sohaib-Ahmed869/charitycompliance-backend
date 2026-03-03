/**
 * Legal Document Service
 * 
 * Business logic for legal document management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { LegalDocumentRepository } from '../repositories/legalDocumentRepository.js';
import { AppError } from '../middleware/errorHandler.js';

export class LegalDocumentService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async createDocument(docData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);

    if (!docData.document_name) {
      throw new AppError('Document name is required', 400, 'DOCUMENT_NAME_REQUIRED');
    }
    if (!docData.category) {
      throw new AppError('Category is required', 400, 'CATEGORY_REQUIRED');
    }

    const document = await repo.create({
      org_id: this.orgId,
      ...docData,
      created_by: userId
    });

    return await repo.findById(document._id);
  }

  async getDocuments(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);
    return await repo.findByOrgId(this.orgId, filters);
  }

  async getDocumentById(docId) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);
    const doc = await repo.findById(docId);

    if (!doc) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    if (doc.org_id !== this.orgId) {
      throw new AppError('Unauthorized access', 403, 'UNAUTHORIZED');
    }

    return doc;
  }

  async updateDocument(docId, updateData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);

    const existing = await repo.findById(docId);
    if (!existing) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    if (existing.org_id !== this.orgId) {
      throw new AppError('Unauthorized access', 403, 'UNAUTHORIZED');
    }

    return await repo.update(docId, updateData);
  }

  async archiveDocument(docId) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);

    const existing = await repo.findById(docId);
    if (!existing) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    if (existing.org_id !== this.orgId) {
      throw new AppError('Unauthorized access', 403, 'UNAUTHORIZED');
    }

    return await repo.archive(docId);
  }

  async uploadNewVersion(docId, versionData, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);

    const existing = await repo.findById(docId);
    if (!existing) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    if (existing.org_id !== this.orgId) {
      throw new AppError('Unauthorized access', 403, 'UNAUTHORIZED');
    }

    return await repo.addVersion(docId, {
      ...versionData,
      uploaded_by: userId
    });
  }

  async getDocumentVersion(docId, versionNumber) {
    const doc = await this.getDocumentById(docId);
    const version = doc.versions.find(v => v.version_number === parseInt(versionNumber));
    if (!version) {
      throw new AppError('Version not found', 404, 'VERSION_NOT_FOUND');
    }
    return version;
  }

  async getStats() {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);
    return await repo.getStats(this.orgId);
  }

  async deleteDocument(docId) {
    const tenantDb = await this.getTenantDb();
    const repo = new LegalDocumentRepository(tenantDb);

    const existing = await repo.findById(docId);
    if (!existing) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    if (existing.org_id !== this.orgId) {
      throw new AppError('Unauthorized access', 403, 'UNAUTHORIZED');
    }

    return await repo.delete(docId);
  }
}
