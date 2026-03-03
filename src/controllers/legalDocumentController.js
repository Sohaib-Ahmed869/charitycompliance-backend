/**
 * Legal Document Controller
 * 
 * Handles HTTP requests for legal document management
 */

import { LegalDocumentService } from '../services/legalDocumentService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToS3, getFileUrl, deleteFromS3 } from '../services/s3Service.js';

export const createDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const docData = req.body;

  if (req.file) {
    const uploadResult = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      orgId,
      'legal-documents'
    );
    docData.versions = [{
      version_number: 1,
      file_key: uploadResult.key,
      file_name: req.file.originalname,
      file_size: req.file.size,
      file_type: req.file.mimetype,
      uploaded_by: userId,
      uploaded_at: new Date()
    }];
    docData.current_version = 1;
  }

  const service = new LegalDocumentService(orgId);
  const document = await service.createDocument(docData, userId);

  res.status(201).json({ success: true, data: document });
});

export const getDocuments = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    category: req.query.category,
    search: req.query.search
  };

  const service = new LegalDocumentService(orgId);
  const documents = await service.getDocuments(filters);

  const docsWithUrls = await Promise.all(documents.map(async (doc) => {
    const docObj = doc.toObject();
    if (docObj.versions?.length > 0) {
      for (const version of docObj.versions) {
        if (version.file_key) {
          try {
            version.file_url = await getFileUrl(version.file_key);
          } catch {
            version.file_url = null;
          }
        }
      }
    }
    return docObj;
  }));

  res.json({ success: true, data: docsWithUrls });
});

export const getDocumentById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new LegalDocumentService(orgId);
  const document = await service.getDocumentById(req.params.id);

  const docObj = document.toObject();
  if (docObj.versions?.length > 0) {
    for (const version of docObj.versions) {
      if (version.file_key) {
        try {
          version.file_url = await getFileUrl(version.file_key);
        } catch {
          version.file_url = null;
        }
      }
    }
  }

  res.json({ success: true, data: docObj });
});

export const updateDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const service = new LegalDocumentService(orgId);
  const document = await service.updateDocument(req.params.id, req.body, userId);

  res.json({ success: true, data: document });
});

export const uploadNewVersion = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;

  if (!req.file) {
    throw new AppError('File is required for new version', 400, 'FILE_REQUIRED');
  }

  const uploadResult = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'legal-documents'
  );

  const versionData = {
    file_key: uploadResult.key,
    file_name: req.file.originalname,
    file_size: req.file.size,
    file_type: req.file.mimetype,
    uploaded_at: new Date()
  };

  const service = new LegalDocumentService(orgId);
  const document = await service.uploadNewVersion(req.params.id, versionData, userId);

  res.json({ success: true, data: document });
});

export const archiveDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new LegalDocumentService(orgId);
  const document = await service.archiveDocument(req.params.id);

  res.json({ success: true, data: document });
});

export const downloadVersion = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new LegalDocumentService(orgId);
  const version = await service.getDocumentVersion(req.params.id, req.params.versionNumber);

  if (!version.file_key) {
    throw new AppError('No file associated with this version', 404, 'FILE_NOT_FOUND');
  }

  const url = await getFileUrl(version.file_key, 3600);
  res.json({ success: true, data: { url, file_name: version.file_name } });
});

export const getStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new LegalDocumentService(orgId);
  const stats = await service.getStats();

  res.json({ success: true, data: stats });
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new LegalDocumentService(orgId);

  const document = await service.getDocumentById(req.params.id);
  for (const version of document.versions || []) {
    if (version.file_key) {
      try { await deleteFromS3(version.file_key); } catch { /* ignore */ }
    }
  }

  await service.deleteDocument(req.params.id);
  res.json({ success: true, message: 'Document deleted successfully' });
});
