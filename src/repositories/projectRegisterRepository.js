/**
 * Project Register Repository
 *
 * Manages project register data operations
 */

import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import { escapeRegex } from '../utils/escapeRegex.js';

export class ProjectRegisterRepository {
  constructor(tenantDb) {
    this.ProjectRegister = tenantDb.models.ProjectRegister || tenantDb.model('ProjectRegister', projectRegisterSchema);
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.search) {
      const pattern = new RegExp(escapeRegex(filters.search), 'i');
      query.$or = [
        { project_name: pattern },
        { agreement_title: pattern },
        { project_code: pattern }
      ];
    }

    return await this.ProjectRegister.find(query)
      .sort({ createdAt: -1 });
  }

  async findById(id) {
    return await this.ProjectRegister.findById(id);
  }

  async create(data) {
    const project = new this.ProjectRegister(data);
    return await project.save();
  }

  async update(id, updateData) {
    return await this.ProjectRegister.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.ProjectRegister.findByIdAndDelete(id);
  }

  async getCountsByOrg(orgId) {
    const projects = await this.ProjectRegister.find({ org_id: orgId });
    const total = projects.length;
    const active = projects.filter((p) => p.status === 'active').length;
    const pending = projects.filter((p) => p.status === 'pending').length;
    const atRisk = projects.filter((p) => p.status === 'at_risk').length;
    const completed = projects.filter((p) => p.status === 'completed').length;

    return {
      total,
      active,
      pending,
      atRisk,
      completed
    };
  }
}
