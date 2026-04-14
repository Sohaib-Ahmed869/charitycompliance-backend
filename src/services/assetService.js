/**
 * Asset Service
 * 
 * Business logic for asset management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { AssetRepository } from '../repositories/assetRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo } from '../utils/logger.js';

export class AssetService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async createAsset(assetData, userId) {
    const tenantDb = await this.getTenantDb();
    const assetRepo = new AssetRepository(tenantDb);

    if (!assetData.asset_name) {
      throw new AppError('Asset name is required', 400, 'ASSET_NAME_REQUIRED');
    }
    if (!assetData.category) {
      throw new AppError('Category is required', 400, 'CATEGORY_REQUIRED');
    }
    if (!assetData.type) {
      throw new AppError('Asset type is required', 400, 'TYPE_REQUIRED');
    }
    const isCredentialsOnly = assetData.metadata?.creation_intent === 'credentials';
    if (!isCredentialsOnly) {
      if (assetData.worth === undefined || assetData.worth === null) {
        throw new AppError('Asset worth is required', 400, 'ASSET_WORTH_REQUIRED');
      }
      if (!assetData.purchase_date) {
        throw new AppError('Purchase date is required', 400, 'PURCHASE_DATE_REQUIRED');
      }
    }

    const asset = await assetRepo.create({
      org_id: this.orgId,
      asset_name: assetData.asset_name,
      category: assetData.category,
      type: assetData.type,
      vendor_name: assetData.vendor_name,
      model: assetData.model,
      serial_number: assetData.serial_number,
      processor: assetData.processor,
      ram: assetData.ram,
      storage: assetData.storage,
      worth: assetData.worth,
      subscription_price: assetData.subscription_price,
      subscription_currency: assetData.subscription_currency,
      billing_frequency: assetData.billing_frequency,
      purchase_date: assetData.purchase_date,
      maintenance_date: assetData.maintenance_date,
      websiteUrl: assetData.websiteUrl,
      admin_name: assetData.admin_name,
      admin_role: assetData.admin_role,
      access_level: assetData.access_level,
      last_login: assetData.last_login,
      policyCompliance: assetData.policyCompliance,
      department_owner: assetData.department_owner,
      assigned_to: assetData.assigned_to,
      status: assetData.status || 'active',
      documentation: assetData.documentation,
      documentation_file_name: assetData.documentation_file_name,
      notes: assetData.notes,
      created_by: userId,
      metadata: assetData.metadata || {}
    });

    logInfo('Asset created', { assetId: asset._id, createdBy: userId });
    return asset;
  }

  async getAssets(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const assetRepo = new AssetRepository(tenantDb);

    return await assetRepo.findByOrgId(this.orgId, filters);
  }

  async getAssetById(assetId) {
    const tenantDb = await this.getTenantDb();
    const assetRepo = new AssetRepository(tenantDb);

    const asset = await assetRepo.findById(assetId);
    if (!asset) {
      throw new AppError('Asset not found', 404, 'ASSET_NOT_FOUND');
    }
    if (asset.org_id !== this.orgId) {
      throw new AppError('Unauthorized access to asset', 403, 'UNAUTHORIZED');
    }

    return asset;
  }

  async updateAsset(assetId, assetData, userId) {
    const tenantDb = await this.getTenantDb();
    const assetRepo = new AssetRepository(tenantDb);

    const asset = await assetRepo.findById(assetId);
    if (!asset) {
      throw new AppError('Asset not found', 404, 'ASSET_NOT_FOUND');
    }
    if (asset.org_id !== this.orgId) {
      throw new AppError('Unauthorized access to asset', 403, 'UNAUTHORIZED');
    }

    const updateData = {
      ...assetData,
      updated_by: userId
    };

    const updatedAsset = await assetRepo.update(assetId, updateData);

    logInfo('Asset updated', { assetId, updatedBy: userId });
    return updatedAsset;
  }

  async deleteAsset(assetId) {
    const tenantDb = await this.getTenantDb();
    const assetRepo = new AssetRepository(tenantDb);

    const asset = await assetRepo.findById(assetId);
    if (!asset) {
      throw new AppError('Asset not found', 404, 'ASSET_NOT_FOUND');
    }
    if (asset.org_id !== this.orgId) {
      throw new AppError('Unauthorized access to asset', 403, 'UNAUTHORIZED');
    }

    await assetRepo.delete(assetId);

    logInfo('Asset deleted', { assetId });
    return asset;
  }

  async getAssetStats() {
    const tenantDb = await this.getTenantDb();
    const assetRepo = new AssetRepository(tenantDb);

    return await assetRepo.getAssetStats(this.orgId);
  }
}
