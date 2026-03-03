/**
 * Asset Routes
 * 
 * API routes for asset management
 */

import express from 'express';
import * as assetController from '../../controllers/assetController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadAssetSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

// All asset routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Create asset
router.post(
  '/',
  uploadAssetSingle,
  handleUploadError,
  [
    body('asset_name')
      .trim()
      .notEmpty()
      .withMessage('Asset name is required'),
    body('category')
      .trim()
      .notEmpty()
      .isIn(['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Other'])
      .withMessage('Valid category is required'),
    body('type')
      .trim()
      .notEmpty()
      .withMessage('Asset type is required'),
    body('worth')
      .isFloat({ min: 0 })
      .withMessage('Asset worth must be a positive number'),
    body('purchase_date')
      .notEmpty()
      .isISO8601()
      .withMessage('Valid purchase date is required')
  ],
  validate,
  assetController.createAsset
);

// Get all assets
router.get(
  '/',
  [
    query('status')
      .optional()
      .isIn(['active', 'inactive', 'maintenance', 'retired'])
      .withMessage('Invalid status'),
    query('category')
      .optional()
      .isIn(['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Other'])
      .withMessage('Invalid category'),
    query('assigned_to')
      .optional()
      .isMongoId()
      .withMessage('Invalid user ID'),
    query('search')
      .optional()
      .trim()
  ],
  validate,
  assetController.getAssets
);

// Get asset stats
router.get('/stats', assetController.getAssetStats);

// Get asset by ID
router.get(
  '/:assetId',
  [
    param('assetId')
      .isMongoId()
      .withMessage('Invalid asset ID')
  ],
  validate,
  assetController.getAssetById
);

// Update asset
router.put(
  '/:assetId',
  uploadAssetSingle,
  handleUploadError,
  [
    param('assetId')
      .isMongoId()
      .withMessage('Invalid asset ID'),
    body('asset_name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Asset name cannot be empty'),
    body('category')
      .optional()
      .isIn(['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Other'])
      .withMessage('Invalid category'),
    body('status')
      .optional()
      .isIn(['active', 'inactive', 'maintenance', 'retired'])
      .withMessage('Invalid status'),
    body('worth')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Asset worth must be a positive number'),
    body('purchase_date')
      .optional()
      .isISO8601()
      .withMessage('Invalid purchase date format')
  ],
  validate,
  assetController.updateAsset
);

// Delete asset
router.delete(
  '/:assetId',
  [
    param('assetId')
      .isMongoId()
      .withMessage('Invalid asset ID')
  ],
  validate,
  assetController.deleteAsset
);

export default router;
