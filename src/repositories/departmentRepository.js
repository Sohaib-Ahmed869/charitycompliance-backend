/**
 * Department Repository
 * 
 * Manages department data operations
 */

import mongoose from 'mongoose';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';

export class DepartmentRepository {
  constructor(tenantDb) {
    this.Department = tenantDb.models.Department || 
      tenantDb.model('Department', departmentSchema);
  }

  async findByOrgId(orgId) {
    return await this.Department.find({ org_id: orgId, is_active: true })
      .sort({ name: 1 });
  }

  async findAllByOrgId(orgId) {
    // Returns ALL departments including inactive ones
    return await this.Department.find({ org_id: orgId })
      .sort({ name: 1 });
  }

  async findById(id) {
    return await this.Department.findById(id);
  }

  async findByParent(orgId, parentId) {
    return await this.Department.find({ 
      org_id: orgId, 
      parent_department_id: parentId,
      is_active: true 
    }).sort({ name: 1 });
  }

  async create(data) {
    const department = new this.Department(data);
    return await department.save();
  }

  async createMany(departments) {
    return await this.Department.insertMany(departments);
  }

  async update(id, updateData) {
    return await this.Department.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.Department.findByIdAndUpdate(
      id,
      { $set: { is_active: false } },
      { new: true }
    );
  }

  async updateEmployeeCount(departmentId, increment = true) {
    const change = increment ? 1 : -1;
    return await this.Department.findByIdAndUpdate(
      departmentId,
      { $inc: { employee_count: change } },
      { new: true }
    );
  }
}
