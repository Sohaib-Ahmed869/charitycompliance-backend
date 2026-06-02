/**
 * Asset Controller
 * 
 * Handles HTTP requests for asset management
 */

import mongoose from 'mongoose';
import { getTenantConnection } from '../db/connectionManager.js';
import { AssetService } from '../services/assetService.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import itRegisterSchema from '../db/schemas/platform/itRegisterSchema.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { AppError } from '../middleware/errorHandler.js';
import { uploadToS3, deleteFromS3, getFileUrl } from '../services/s3Service.js';
import { encryptSecret, decryptSecret } from '../services/secretCryptoService.js';

const normalizeAssignedTo = (assignedTo) => {
  if (!assignedTo) return undefined;
  if (mongoose.Types.ObjectId.isValid(assignedTo)) {
    return new mongoose.Types.ObjectId(assignedTo);
  }
  return undefined;
};

const normalizeRecordLocationRow = (row) => ({
  ...row,
  organizationId: row.organizationId || row.org_id,
  name: row.name || row.location_name || '',
  type: row.type || row.location_type || '',
  recordCategories: Array.isArray(row.recordCategories)
    ? row.recordCategories
    : (Array.isArray(row.record_categories) ? row.record_categories : []),
  accessLevel: row.accessLevel || row.access_level || '',
  responsiblePerson: row.responsiblePerson || row.responsible_person || '',
  responsibleUserId: row.responsibleUserId || row.responsible_user_id || null,
  retentionPolicy: row.retentionPolicy || row.retention_period || '',
  retentionEndDate: row.retentionEndDate || null,
  lastAuditDate: row.lastAuditDate || row.last_audit_date || null,
  nextAuditDue: row.nextAuditDue || null,
  review_comment: row.review_comment || '',
  reviewed_at: row.reviewed_at || null,
  reviewed_by: row.reviewed_by || null,
  documents: Array.isArray(row.documents) ? row.documents : []
});

export const createAsset = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const assetData = { ...req.body };

  // metadata may arrive as JSON string from multipart forms
  if (typeof assetData?.metadata === 'string') {
    try {
      assetData.metadata = JSON.parse(assetData.metadata);
    } catch {
      assetData.metadata = {};
    }
  }
  if (typeof assetData?.policyCompliance === 'string') {
    try {
      assetData.policyCompliance = JSON.parse(assetData.policyCompliance);
    } catch {
      assetData.policyCompliance = {};
    }
  }
  // bank_cards arrives as a JSON-stringified array when posted via
  // multipart (which the create modal uses for file upload). Parse so
  // the asset schema receives the proper array shape. Also normalise
  // numeric fields — multipart stringifies everything.
  if (typeof assetData?.bank_cards === 'string') {
    try {
      assetData.bank_cards = JSON.parse(assetData.bank_cards);
    } catch {
      assetData.bank_cards = [];
    }
  }
  if (Array.isArray(assetData.bank_cards)) {
    assetData.bank_cards = assetData.bank_cards.map((c) => ({
      ...c,
      expiry_month: c?.expiry_month ? Number(c.expiry_month) : undefined,
      expiry_year:  c?.expiry_year  ? Number(c.expiry_year)  : undefined,
      credit_limit: (c?.credit_limit !== undefined && c?.credit_limit !== '')
        ? Number(c.credit_limit)
        : undefined
    }));
  }

  const creationIntent = assetData.creation_intent === 'credentials' ? 'credentials' : 'subscription';
  delete assetData.creation_intent;

  assetData.metadata = { ...(assetData.metadata || {}), creation_intent: creationIntent };

  if (creationIntent !== 'credentials' && !req.file) {
    throw new AppError('Documentation file is required', 400, 'FILE_REQUIRED');
  }

  let uploadResult = null;
  if (req.file) {
    uploadResult = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      orgId,
      'assets'
    );
  }

  const assetService = new AssetService(orgId);
  const isCredentials = creationIntent === 'credentials';
  const worthParsed = assetData.worth !== undefined && assetData.worth !== null && String(assetData.worth).trim() !== ''
    ? parseFloat(assetData.worth)
    : undefined;
  const policyCompliance = assetData.policyCompliance && typeof assetData.policyCompliance === 'object'
    ? {
      privacyPolicyUpdated: assetData.policyCompliance.privacyPolicyUpdated === true || String(assetData.policyCompliance.privacyPolicyUpdated) === 'true',
      termsUpdated: assetData.policyCompliance.termsUpdated === true || String(assetData.policyCompliance.termsUpdated) === 'true',
      accessibilityChecked: assetData.policyCompliance.accessibilityChecked === true || String(assetData.policyCompliance.accessibilityChecked) === 'true',
      sslExpiry: assetData.policyCompliance.sslExpiry ? new Date(assetData.policyCompliance.sslExpiry) : null
    }
    : undefined;
  const asset = await assetService.createAsset({
    ...assetData,
    assigned_to: normalizeAssignedTo(assetData.assigned_to),
    documentation: uploadResult?.key,
    documentation_file_name: req.file?.originalname,
    purchase_date: isCredentials
      ? (assetData.purchase_date ? new Date(assetData.purchase_date) : new Date())
      : new Date(assetData.purchase_date),
    maintenance_date: assetData.maintenance_date ? new Date(assetData.maintenance_date) : undefined,
    websiteUrl: assetData.websiteUrl || '',
    admin_name: assetData.admin_name || '',
    admin_role: assetData.admin_role || '',
    access_level: assetData.access_level || '',
    last_login: assetData.last_login ? new Date(assetData.last_login) : null,
    policyCompliance,
    worth: isCredentials ? (Number.isFinite(worthParsed) ? worthParsed : 0) : worthParsed
  }, userId);

  const documentationUrl = uploadResult?.url || null;

  res.status(201).json({
    success: true,
    data: {
      ...asset.toObject(),
      documentation_url: documentationUrl
    }
  });
});

export const getAssets = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    category: req.query.category,
    assigned_to: req.query.assigned_to,
    searchTerm: req.query.search
  };

  const assetService = new AssetService(orgId);
  const assets = await assetService.getAssets(filters);

  const assetsWithUrls = await Promise.all(
    assets.map(async (asset) => {
      if (!asset.documentation) {
        return asset;
      }
      try {
        const url = await getFileUrl(asset.documentation);
        return {
          ...asset.toObject(),
          documentation_url: url
        };
      } catch (error) {
        return asset;
      }
    })
  );

  res.json({
    success: true,
    data: assetsWithUrls
  });
});

export const getAssetById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { assetId } = req.params;

  const assetService = new AssetService(orgId);
  const asset = await assetService.getAssetById(assetId);

  let documentationUrl = null;
  if (asset.documentation) {
    documentationUrl = await getFileUrl(asset.documentation);
  }

  res.json({
    success: true,
    data: {
      ...asset.toObject(),
      documentation_url: documentationUrl
    }
  });
});

export const updateAsset = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const { assetId } = req.params;
  const assetData = req.body;

  if (typeof assetData?.metadata === 'string') {
    try {
      assetData.metadata = JSON.parse(assetData.metadata);
    } catch {
      assetData.metadata = {};
    }
  }
  if (typeof assetData?.policyCompliance === 'string') {
    try {
      assetData.policyCompliance = JSON.parse(assetData.policyCompliance);
    } catch {
      assetData.policyCompliance = {};
    }
  }
  // bank_cards arrives as a JSON-stringified array when posted via
  // multipart (which the create modal uses for file upload). Parse so
  // the asset schema receives the proper array shape. Also normalise
  // numeric fields — multipart stringifies everything.
  if (typeof assetData?.bank_cards === 'string') {
    try {
      assetData.bank_cards = JSON.parse(assetData.bank_cards);
    } catch {
      assetData.bank_cards = [];
    }
  }
  if (Array.isArray(assetData.bank_cards)) {
    assetData.bank_cards = assetData.bank_cards.map((c) => ({
      ...c,
      expiry_month: c?.expiry_month ? Number(c.expiry_month) : undefined,
      expiry_year:  c?.expiry_year  ? Number(c.expiry_year)  : undefined,
      credit_limit: (c?.credit_limit !== undefined && c?.credit_limit !== '')
        ? Number(c.credit_limit)
        : undefined
    }));
  }

  if (req.file) {
    const uploadResult = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      orgId,
      'assets'
    );
    assetData.documentation = uploadResult.key;
    assetData.documentation_file_name = req.file.originalname;
  }

  assetData.assigned_to = normalizeAssignedTo(assetData.assigned_to);
  if (assetData.purchase_date) {
    assetData.purchase_date = new Date(assetData.purchase_date);
  }
  if (assetData.maintenance_date) {
    assetData.maintenance_date = new Date(assetData.maintenance_date);
  }
  if (assetData.last_login) {
    assetData.last_login = new Date(assetData.last_login);
  }
  if (assetData.worth) {
    assetData.worth = parseFloat(assetData.worth);
  }
  if (assetData.policyCompliance && typeof assetData.policyCompliance === 'object') {
    assetData.policyCompliance = {
      privacyPolicyUpdated: assetData.policyCompliance.privacyPolicyUpdated === true || String(assetData.policyCompliance.privacyPolicyUpdated) === 'true',
      termsUpdated: assetData.policyCompliance.termsUpdated === true || String(assetData.policyCompliance.termsUpdated) === 'true',
      accessibilityChecked: assetData.policyCompliance.accessibilityChecked === true || String(assetData.policyCompliance.accessibilityChecked) === 'true',
      sslExpiry: assetData.policyCompliance.sslExpiry ? new Date(assetData.policyCompliance.sslExpiry) : null
    };
  }

  const assetService = new AssetService(orgId);
  const asset = await assetService.updateAsset(assetId, assetData, userId);

  let documentationUrl = null;
  if (asset.documentation) {
    documentationUrl = await getFileUrl(asset.documentation);
  }

  res.json({
    success: true,
    data: {
      ...asset.toObject(),
      documentation_url: documentationUrl
    }
  });
});

export const deleteAsset = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { assetId } = req.params;

  const assetService = new AssetService(orgId);
  const asset = await assetService.deleteAsset(assetId);

  if (asset.documentation) {
    await deleteFromS3(asset.documentation);
  }

  res.json({
    success: true,
    data: { success: true, message: 'Asset deleted successfully' }
  });
});

export const getAssetStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;

  const assetService = new AssetService(orgId);
  const stats = await assetService.getAssetStats();

  res.json({
    success: true,
    data: stats
  });
});

export const updateAssetCredentials = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { assetId } = req.params;
  const {
    access_mode,
    credential_type,
    username,
    password,
    api_key,
    notes,
    authorized_person_name,
    authorized_person_role,
    authorized_person_email,
    authorized_person_phone,
    authorized_person_notes,
    bank_name,
    account_name,
    account_number_last4,
    bsb_last3,
    portal_url,
    portal_customer_id
  } = req.body || {};

  const assetService = new AssetService(orgId);
  const asset = await assetService.getAssetById(assetId);

  const accessMode = access_mode === 'authorized_person_only' ? 'authorized_person_only' : 'direct_credentials';
  const allowedCredentialTypes = new Set([
    'general',
    'bank_credentials',
    'banking_portal',
    'online_presence',
    'google_workspace',
    'google_ads',
    'social_media'
  ]);
  const credentialType = allowedCredentialTypes.has(credential_type) ? credential_type : 'general';

  const payload = encryptSecret(
    JSON.stringify({
      access_mode: accessMode,
      credential_type: credentialType,
      username: username || '',
      password: password || '',
      api_key: api_key || '',
      notes: notes || '',
      authorized_person_name: authorized_person_name || '',
      authorized_person_role: authorized_person_role || '',
      authorized_person_email: authorized_person_email || '',
      authorized_person_phone: authorized_person_phone || '',
      authorized_person_notes: authorized_person_notes || '',
      bank_name: bank_name || '',
      account_name: account_name || '',
      account_number_last4: account_number_last4 || '',
      bsb_last3: bsb_last3 || '',
      portal_url: portal_url || '',
      portal_customer_id: portal_customer_id || ''
    })
  );

  const updated = await assetService.updateAsset(assetId, {
    credentials: {
      ...payload,
      meta: {
        username_hint: username ? username.slice(-4) : ''
      }
    }
  }, userId);

  res.json({
    success: true,
    data: {
      _id: updated._id,
      has_credentials: !!updated.credentials?.cipher_text
    }
  });
});

export const getAssetCredentials = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { assetId } = req.params;

  const assetService = new AssetService(orgId);
  const asset = await assetService.getAssetById(assetId);

  const decoded = decryptSecret(asset.credentials || {});
  let parsed = {
    access_mode: 'direct_credentials',
    credential_type: 'general',
    username: '',
    password: '',
    api_key: '',
    notes: '',
    authorized_person_name: '',
    authorized_person_role: '',
    authorized_person_email: '',
    authorized_person_phone: '',
    authorized_person_notes: '',
    bank_name: '',
    account_name: '',
    account_number_last4: '',
    bsb_last3: '',
    portal_url: '',
    portal_customer_id: ''
  };
  if (decoded) {
    try {
      parsed = { ...parsed, ...(JSON.parse(decoded) || {}) };
    } catch {
      // keep safe defaults for backward compatibility
    }
  }

  // Normalize credential_type to supported values
  const allowedCredentialTypes = new Set([
    'general',
    'bank_credentials',
    'banking_portal',
    'online_presence',
    'google_workspace',
    'google_ads',
    'social_media'
  ]);
  if (!allowedCredentialTypes.has(parsed.credential_type)) {
    parsed.credential_type = 'general';
  }

  res.json({
    success: true,
    data: {
      ...parsed,
      has_credentials: !!asset.credentials?.cipher_text
    }
  });
});

export const getPhysicalStorageLocations = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const ITRegister = tenantDb.models.ITRegister || tenantDb.model('ITRegister', itRegisterSchema);
  const itRegister = await ITRegister.findOne({ org_id: org._id }).lean();
  let rows = Array.isArray(itRegister?.physical_locations) ? itRegister.physical_locations : [];
  if (!rows.length) {
    // Backward compatibility with legacy collections.
    const legacyRows = await tenantDb.collection('physical_storage_locations')
      .find({ org_id: orgId })
      .sort({ created_at: -1 })
      .toArray();
    const legacyRecordRows = !legacyRows.length
      ? await tenantDb.collection('record_locations')
        .find({ org_id: orgId })
        .sort({ created_at: -1 })
        .toArray()
      : [];
    const sourceRows = legacyRows.length ? legacyRows : legacyRecordRows;
    if (sourceRows.length) {
      const now = new Date();
      const migratedRows = sourceRows.map((r) => {
        const normalized = normalizeRecordLocationRow(r);
        return {
          _id: normalized._id || new mongoose.Types.ObjectId(),
          org_id: orgId,
          organizationId: org._id,
          name: normalized.name,
          type: normalized.type,
          address: normalized.address || '',
          recordCategories: normalized.recordCategories || [],
          accessLevel: normalized.accessLevel || '',
          access_restrictions: normalized.access_restrictions || '',
          responsiblePerson: normalized.responsiblePerson || '',
          responsibleUserId: normalized.responsibleUserId || null,
          retentionPolicy: normalized.retentionPolicy || '',
          retentionEndDate: normalized.retentionEndDate || null,
          lastAuditDate: normalized.lastAuditDate || null,
          nextAuditDue: normalized.nextAuditDue || null,
          notes: normalized.notes || '',
          documents: Array.isArray(normalized.documents) ? normalized.documents : [],
          created_by: normalized.created_by || null,
          updated_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : null,
          created_at: normalized.created_at || now,
          updated_at: now
        };
      });

      await ITRegister.findOneAndUpdate(
        { org_id: org._id },
        {
          $set: {
            physical_locations: migratedRows,
            updated_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : null
          }
        },
        { upsert: true, new: true }
      );
      rows = migratedRows;
    }
  }
  const normalized = rows.map(normalizeRecordLocationRow);

  res.json({
    success: true,
    data: normalized
  });
});

export const createPhysicalStorageLocation = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }
  const {
    name,
    type,
    address,
    recordCategories = [],
    accessLevel = '',
    access_restrictions = '',
    responsiblePerson = '',
    responsibleUserId = null,
    retentionPolicy = '',
    retentionEndDate = null,
    lastAuditDate = null,
    nextAuditDue = null,
    notes = '',
    documents = []
  } = req.body || {};

  if (!String(name || '').trim()) {
    throw new AppError('Name is required', 400, 'VALIDATION_ERROR');
  }
  if (!['on-site', 'off-site', 'archive'].includes(String(type || ''))) {
    throw new AppError('Type must be on-site, off-site, or archive', 400, 'VALIDATION_ERROR');
  }
  if (!String(responsiblePerson || '').trim() && !String(responsibleUserId || '').trim()) {
    throw new AppError('Responsible person is required', 400, 'VALIDATION_ERROR');
  }

  const now = new Date();
  const parsedLastAudit = lastAuditDate ? new Date(lastAuditDate) : null;
  const parsedNextAudit = nextAuditDue
    ? new Date(nextAuditDue)
    : (parsedLastAudit ? new Date(parsedLastAudit.getFullYear() + 1, parsedLastAudit.getMonth(), parsedLastAudit.getDate()) : null);
  const parsedRetentionEnd = retentionEndDate ? new Date(retentionEndDate) : null;

  const doc = {
    _id: new mongoose.Types.ObjectId(),
    org_id: orgId,
    organizationId: org._id,
    name: String(name).trim(),
    type: String(type).trim(),
    address: String(address || '').trim(),
    recordCategories: Array.isArray(recordCategories)
      ? recordCategories.map((x) => String(x || '').trim()).filter(Boolean)
      : [],
    accessLevel: String(accessLevel || '').trim(),
    access_restrictions: String(access_restrictions || '').trim(),
    responsiblePerson: String(responsiblePerson || '').trim(),
    responsibleUserId: responsibleUserId && mongoose.Types.ObjectId.isValid(responsibleUserId)
      ? new mongoose.Types.ObjectId(responsibleUserId)
      : null,
    retentionPolicy: String(retentionPolicy || '').trim(),
    retentionEndDate: parsedRetentionEnd && !Number.isNaN(parsedRetentionEnd.getTime()) ? parsedRetentionEnd : null,
    lastAuditDate: parsedLastAudit && !Number.isNaN(parsedLastAudit.getTime()) ? parsedLastAudit : null,
    nextAuditDue: parsedNextAudit && !Number.isNaN(parsedNextAudit.getTime()) ? parsedNextAudit : null,
    notes: String(notes || '').trim(),
    documents: Array.isArray(documents) ? documents : [],
    created_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : null,
    updated_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : null,
    created_at: now,
    updated_at: now
  };

  const ITRegister = tenantDb.models.ITRegister || tenantDb.model('ITRegister', itRegisterSchema);
  await ITRegister.findOneAndUpdate(
    { org_id: org._id },
    {
      $set: {
        updated_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : null
      },
      $push: {
        physical_locations: doc
      }
    },
    { upsert: true, new: true }
  );

  res.status(201).json({
    success: true,
    data: doc
  });
});

export const updatePhysicalStorageLocation = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { locationId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  if (!mongoose.Types.ObjectId.isValid(locationId)) {
    throw new AppError('Invalid location ID', 400, 'VALIDATION_ERROR');
  }

  const ITRegister = tenantDb.models.ITRegister || tenantDb.model('ITRegister', itRegisterSchema);
  const itRegister = await ITRegister.findOne({ org_id: org._id });
  if (!itRegister || !Array.isArray(itRegister.physical_locations)) {
    throw new AppError('Location not found', 404, 'NOT_FOUND');
  }

  const idx = itRegister.physical_locations.findIndex((loc) => String(loc?._id) === String(locationId));
  if (idx === -1) throw new AppError('Location not found', 404, 'NOT_FOUND');
  const existing = itRegister.physical_locations[idx];
  const payload = req.body || {};
  const now = new Date();

  const next = {
    ...existing.toObject(),
    name: payload.name !== undefined ? String(payload.name || '').trim() : existing.name,
    type: payload.type !== undefined ? String(payload.type || '').trim() : existing.type,
    address: payload.address !== undefined ? String(payload.address || '').trim() : existing.address,
    recordCategories: Array.isArray(payload.recordCategories) ? payload.recordCategories.map((x) => String(x || '').trim()).filter(Boolean) : existing.recordCategories,
    accessLevel: payload.accessLevel !== undefined ? String(payload.accessLevel || '').trim() : existing.accessLevel,
    access_restrictions: payload.access_restrictions !== undefined ? String(payload.access_restrictions || '').trim() : existing.access_restrictions,
    responsiblePerson: payload.responsiblePerson !== undefined ? String(payload.responsiblePerson || '').trim() : existing.responsiblePerson,
    responsibleUserId: payload.responsibleUserId !== undefined
      ? (payload.responsibleUserId && mongoose.Types.ObjectId.isValid(payload.responsibleUserId) ? new mongoose.Types.ObjectId(payload.responsibleUserId) : null)
      : existing.responsibleUserId,
    retentionPolicy: payload.retentionPolicy !== undefined ? String(payload.retentionPolicy || '').trim() : existing.retentionPolicy,
    retentionEndDate: payload.retentionEndDate !== undefined ? (payload.retentionEndDate ? new Date(payload.retentionEndDate) : null) : existing.retentionEndDate,
    lastAuditDate: payload.lastAuditDate !== undefined ? (payload.lastAuditDate ? new Date(payload.lastAuditDate) : null) : existing.lastAuditDate,
    nextAuditDue: payload.nextAuditDue !== undefined ? (payload.nextAuditDue ? new Date(payload.nextAuditDue) : null) : existing.nextAuditDue,
    notes: payload.notes !== undefined ? String(payload.notes || '').trim() : existing.notes,
    review_comment: payload.review_comment !== undefined ? String(payload.review_comment || '').trim() : existing.review_comment,
    reviewed_at: now,
    reviewed_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : null,
    updated_by: req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : existing.updated_by,
    updated_at: now
  };

  itRegister.physical_locations[idx] = next;
  itRegister.updated_by = req.user?.userId ? new mongoose.Types.ObjectId(req.user.userId) : itRegister.updated_by;
  await itRegister.save();

  res.json({
    success: true,
    data: normalizeRecordLocationRow(itRegister.physical_locations[idx].toObject ? itRegister.physical_locations[idx].toObject() : itRegister.physical_locations[idx])
  });
});

