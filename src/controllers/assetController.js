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

  if (!req.file) {
    throw new AppError('Documentation file is required', 400, 'FILE_REQUIRED');
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const assetData = req.body;

  const uploadResult = await uploadToS3(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    orgId,
    'assets'
  );

  const assetService = new AssetService(orgId);
  const asset = await assetService.createAsset({
    ...assetData,
    assigned_to: normalizeAssignedTo(assetData.assigned_to),
    documentation: uploadResult.key,
    documentation_file_name: req.file.originalname,
    purchase_date: new Date(assetData.purchase_date),
    maintenance_date: assetData.maintenance_date ? new Date(assetData.maintenance_date) : undefined,
    worth: assetData.worth ? parseFloat(assetData.worth) : assetData.worth
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
