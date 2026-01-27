/**
 * Activity Repository
 * 
 * Manages operating activities, programs, and grants
 */

import mongoose from 'mongoose';
import activitySchema from '../db/schemas/platform/activitySchema.js';

export class ActivityRepository {
  constructor(tenantDb) {
    this.Activity = tenantDb.models.Activity || 
      tenantDb.model('Activity', activitySchema);
  }

  async findByOrgId(orgId, includeInactive = false) {
    const query = { org_id: orgId };
    if (!includeInactive) {
      query.status = 'active';
    }
    return await this.Activity.find(query).sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.Activity.findById(id);
  }

  async create(data) {
    const activity = new this.Activity(data);
    return await activity.save();
  }

  async update(id, data) {
    return await this.Activity.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true }
    );
  }

  async delete(id) {
    return await this.Activity.findByIdAndUpdate(
      id,
      { $set: { status: 'inactive' } },
      { new: true }
    );
  }

  async countByOrgId(orgId) {
    return await this.Activity.countDocuments({ 
      org_id: orgId, 
      status: 'active' 
    });
  }
}
