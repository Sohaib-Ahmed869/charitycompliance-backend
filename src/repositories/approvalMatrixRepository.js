/**
 * Approval Matrix Repository
 * 
 * Manages approval matrix data operations
 */

import mongoose from 'mongoose';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';

export class ApprovalMatrixRepository {
  constructor(tenantDb) {
    this.ApprovalMatrix = tenantDb.models.ApprovalMatrix || 
      tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
  }

  async findByOrgId(orgId, options = {}) {
    const { includeInactive = false } = options;
    const query = { org_id: orgId };
    if (!includeInactive) query.is_active = true;
    return await this.ApprovalMatrix.find(query);
  }

  /**
   * Matrices that are currently effective and not revoked/inactive.
   * A matrix is effective when:
   * - effective_from is null OR effective_from <= asOf
   * - effective_to is null OR effective_to >= asOf
   */
  async findEffectiveByOrgId(orgId, asOf = new Date()) {
    const d = asOf instanceof Date ? asOf : new Date(asOf);
    return await this.ApprovalMatrix.find({
      org_id: orgId,
      is_active: true,
      revoked_at: null,
      $and: [
        { $or: [{ effective_from: null }, { effective_from: { $lte: d } }] },
        { $or: [{ effective_to: null }, { effective_to: { $gte: d } }] }
      ]
    });
  }

  async findDefault(orgId) {
    return await this.ApprovalMatrix.findOne({ 
      org_id: orgId, 
      is_default: true, 
      is_active: true 
    });
  }

  async findById(id) {
    return await this.ApprovalMatrix.findById(id);
  }

  async create(data) {
    const matrix = new this.ApprovalMatrix(data);
    return await matrix.save();
  }

  async update(id, updateData) {
    return await this.ApprovalMatrix.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.ApprovalMatrix.findByIdAndUpdate(
      id,
      { $set: { is_active: false } },
      { new: true }
    );
  }

  async setAsDefault(orgId, matrixId) {
    // Unset all other defaults
    await this.ApprovalMatrix.updateMany(
      { org_id: orgId },
      { $set: { is_default: false } }
    );
    
    // Set this one as default
    return await this.ApprovalMatrix.findByIdAndUpdate(
      matrixId,
      { $set: { is_default: true } },
      { new: true }
    );
  }
}
