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
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { uploadAssetSingle, handleUploadError } from '../../middleware/upload.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireMfa } from '../../middleware/mfa.js';

const router = express.Router();

// All asset routes require authentication and tenant resolution
router.use(authAndResolveTenant);
router.use(requireFeatureFlag('it.register'));

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
      .isIn(['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Hardware', 'Subscription', 'Domain', 'Cloud Service', 'Banking Details', 'Other'])
      .withMessage('Valid category is required'),
    body('type')
      .trim()
      .notEmpty()
      .withMessage('Asset type is required'),
    body('creation_intent')
      .optional()
      .isIn(['subscription', 'credentials'])
      .withMessage('Invalid creation intent'),
    body('worth').custom((value, { req }) => {
      const intent = req.body.creation_intent === 'credentials' ? 'credentials' : 'subscription';
      if (intent === 'credentials') return true;
      if (value === undefined || value === null || String(value).trim() === '') {
        throw new Error('Asset worth is required');
      }
      const n = parseFloat(value);
      if (Number.isNaN(n) || n < 0) {
        throw new Error('Asset worth must be a positive number');
      }
      return true;
    }),
    body('purchase_date').custom((value, { req }) => {
      const intent = req.body.creation_intent === 'credentials' ? 'credentials' : 'subscription';
      if (intent === 'credentials') return true;
      if (!value || String(value).trim() === '') {
        throw new Error('Valid purchase date is required');
      }
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new Error('Valid purchase date is required');
      }
      return true;
    })
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
      .isIn(['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Hardware', 'Subscription', 'Domain', 'Cloud Service', 'Banking Details', 'Other'])
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

// Physical record-keeping register (paper archives)
router.get('/physical-storage', assetController.getPhysicalStorageLocations);
router.post(
  '/physical-storage',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('type').isIn(['on-site', 'off-site', 'archive']).withMessage('Type must be on-site, off-site, or archive'),
    body('address').optional().isString(),
    body('recordCategories').optional().isArray().withMessage('Record categories must be an array'),
    body('accessLevel').optional().isString(),
    body('access_restrictions').optional().isString(),
    body('responsiblePerson').optional().isString(),
    body('responsibleUserId').optional({ nullable: true }).isMongoId().withMessage('Responsible user must be a valid user ID'),
    body('retentionPolicy').optional().isString(),
    body('retentionEndDate').optional({ nullable: true }).isISO8601().withMessage('Retention end date must be valid'),
    body('lastAuditDate').optional({ nullable: true }).isISO8601().withMessage('Last audit date must be valid'),
    body('nextAuditDue').optional({ nullable: true }).isISO8601().withMessage('Next audit due date must be valid'),
    body('notes').optional().isString(),
    body('documents').optional().isArray().withMessage('Documents must be an array')
  ],
  validate,
  assetController.createPhysicalStorageLocation
);
router.patch(
  '/physical-storage/:locationId',
  [
    param('locationId').isMongoId().withMessage('Invalid location ID'),
    body('name').optional().isString(),
    body('type').optional().isIn(['on-site', 'off-site', 'archive']).withMessage('Type must be on-site, off-site, or archive'),
    body('address').optional().isString(),
    body('recordCategories').optional().isArray().withMessage('Record categories must be an array'),
    body('accessLevel').optional().isString(),
    body('access_restrictions').optional().isString(),
    body('responsiblePerson').optional().isString(),
    body('responsibleUserId').optional({ nullable: true }).isMongoId().withMessage('Responsible user must be a valid user ID'),
    body('retentionPolicy').optional().isString(),
    body('retentionEndDate').optional({ nullable: true }).isISO8601().withMessage('Retention end date must be valid'),
    body('lastAuditDate').optional({ nullable: true }).isISO8601().withMessage('Last audit date must be valid'),
    body('nextAuditDue').optional({ nullable: true }).isISO8601().withMessage('Next audit due date must be valid'),
    body('notes').optional().isString(),
    body('review_comment').optional().isString()
  ],
  validate,
  assetController.updatePhysicalStorageLocation
);

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
      .isIn(['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Hardware', 'Subscription', 'Domain', 'Cloud Service', 'Banking Details', 'Other'])
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

// Credentials: update (encrypted) and fetch (decrypted)
router.post(
  '/:assetId/credentials',
  [
    param('assetId').isMongoId().withMessage('Invalid asset ID')
  ],
  validate,
  requirePermission('module:asset_mgmt:edit'),
  requireMfa('asset_credentials'),
  assetController.updateAssetCredentials
);

router.get(
  '/:assetId/credentials',
  [
    param('assetId').isMongoId().withMessage('Invalid asset ID')
  ],
  validate,
  requirePermission('module:asset_mgmt:view'),
  requireMfa('asset_credentials'),
  assetController.getAssetCredentials
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
