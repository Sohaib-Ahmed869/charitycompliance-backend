/**
 * Asset Repository
 * 
 * Manages asset data operations
 */

import assetSchema from '../db/schemas/platform/assetSchema.js';
import { UserRepository } from './userRepository.js';
import { escapeRegex } from '../utils/escapeRegex.js';

export class AssetRepository {
  constructor(tenantDb) {
    new UserRepository(tenantDb);

    this.Asset = tenantDb.models.Asset ||
      tenantDb.model('Asset', assetSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.category) {
      query.category = filters.category;
    }

    if (filters.assigned_to) {
      query.assigned_to = filters.assigned_to;
    }

    if (filters.searchTerm) {
      const rx = escapeRegex(filters.searchTerm);
      query.$or = [
        { asset_name: { $regex: rx, $options: 'i' } },
        { serial_number: { $regex: rx, $options: 'i' } }
      ];
    }

    return await this.Asset.find(query)
      .populate('assigned_to', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email')
      .populate('updated_by', 'first_name last_name email')
      .sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.Asset.findById(id)
      .populate('assigned_to', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email')
      .populate('updated_by', 'first_name last_name email');
  }

  /**
   * Dedup lookup for bulk import: find an asset in this org whose serial
   * number or name matches (case-insensitive exact). serial_number and
   * asset_name are plaintext, so a straight anchored regex suffices.
   * Returns the first match or null.
   */
  async findExistingByDedup(orgId, { serialNumber, assetName } = {}) {
    const or = [];
    const exact = (v) => new RegExp(`^${String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (String(serialNumber || '').trim()) or.push({ serial_number: exact(serialNumber) });
    if (String(assetName || '').trim()) or.push({ asset_name: exact(assetName) });
    if (or.length === 0) return null;
    return this.Asset.findOne({ org_id: orgId, $or: or });
  }

  async create(data) {
    const asset = new this.Asset(data);
    return await asset.save();
  }

  async update(id, updateData) {
    return await this.Asset.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('assigned_to', 'first_name last_name email')
      .populate('created_by', 'first_name last_name email')
      .populate('updated_by', 'first_name last_name email');
  }

  async delete(id) {
    return await this.Asset.findByIdAndDelete(id);
  }

  async getAssetStats(orgId) {
    const stats = await this.Asset.aggregate([
      { $match: { org_id: orgId } },
      {
        $facet: {
          totalAssets: [{ $count: 'count' }],
          activeAssets: [
            { $match: { status: 'active' } },
            { $count: 'count' }
          ],
          maintenanceAssets: [
            { $match: { status: 'maintenance' } },
            { $count: 'count' }
          ],
          totalValue: [
            { $group: { _id: null, total: { $sum: '$worth' } } }
          ]
        }
      }
    ]);

    return {
      totalAssets: stats[0].totalAssets[0]?.count || 0,
      activeAssets: stats[0].activeAssets[0]?.count || 0,
      maintenanceAssets: stats[0].maintenanceAssets[0]?.count || 0,
      totalValue: stats[0].totalValue[0]?.total || 0
    };
  }
}
