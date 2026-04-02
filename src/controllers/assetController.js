/**
 * Asset Controller
 * 
 * Handles HTTP requests for asset management
 */

import mongoose from 'mongoose';
import { getTenantConnection } from '../db/connectionManager.js';
import { AssetService } from '../services/assetService.js';
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
  const asset = await assetService.createAsset({
    ...assetData,
    assigned_to: normalizeAssignedTo(assetData.assigned_to),
    documentation: uploadResult?.key,
    documentation_file_name: req.file?.originalname,
    purchase_date: isCredentials
      ? (assetData.purchase_date ? new Date(assetData.purchase_date) : new Date())
      : new Date(assetData.purchase_date),
    maintenance_date: assetData.maintenance_date ? new Date(assetData.maintenance_date) : undefined,
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
  if (assetData.worth) {
    assetData.worth = parseFloat(assetData.worth);
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

