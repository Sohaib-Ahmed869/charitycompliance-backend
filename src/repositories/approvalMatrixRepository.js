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

  async findByOrgId(orgId) {
    return await this.ApprovalMatrix.find({ org_id: orgId, is_active: true });
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
