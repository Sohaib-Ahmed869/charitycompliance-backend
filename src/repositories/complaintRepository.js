/**
 * Complaint Repository
 * 
 * Manages complaint data operations
 */

import mongoose from 'mongoose';
import complaintSchema from '../db/schemas/platform/complaintSchema.js';
import publicComplaintLinkSchema from '../db/schemas/platform/publicComplaintLinkSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';
import { UserRepository } from './userRepository.js';

export class ComplaintRepository {
  constructor(tenantDb) {
    // Register User model for populate() operations
    new UserRepository(tenantDb);
    
    // Register Department model for populate() operations
    if (!tenantDb.models.Department) {
      tenantDb.model('Department', departmentSchema);
    }

    this.Complaint = tenantDb.models.Complaint ||
      tenantDb.model('Complaint', complaintSchema);
  }

  async create(complaintData) {
    const complaint = await this.Complaint.create(complaintData);
    return complaint;
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.category) {
      query.category = filters.category;
    }

    if (filters.priority) {
      query.priority = filters.priority;
    }

    if (filters.assigned_to) {
      // Convert string ID to ObjectId if needed
      query.assigned_to = typeof filters.assigned_to === 'string' 
        ? new mongoose.Types.ObjectId(filters.assigned_to)
        : filters.assigned_to;
    }

    if (filters.startDate || filters.endDate) {
      query.created_at = {};
      if (filters.startDate) {
        query.created_at.$gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        query.created_at.$lte = new Date(filters.endDate);
      }
    }

    return await this.Complaint.find(query)
      .populate('assigned_to', 'first_name last_name email')
      .populate('category', 'name')
      .sort({ created_at: -1 });
  }

  async findById(complaintId) {
    return await this.Complaint.findById(complaintId)
      .populate('assigned_to', 'first_name last_name email')
      .populate('category', 'name');
  }

  async update(complaintId, updateData) {
    return await this.Complaint.findByIdAndUpdate(
      complaintId,
      { ...updateData, updated_at: new Date() },
      { new: true }
    ).populate('assigned_to', 'first_name last_name email')
     .populate('category', 'name');
  }

  async updateWithOps(complaintId, ops = {}, options = {}) {
    const $set = { ...(ops.$set || {}), updated_at: new Date() };
    const update = { ...ops, $set };
    return await this.Complaint.findByIdAndUpdate(complaintId, update, { new: true, ...options })
      .populate('assigned_to', 'first_name last_name email')
      .populate('category', 'name');
  }

  async delete(complaintId) {
    return await this.Complaint.findByIdAndDelete(complaintId);
  }

  async getStats(orgId, userId = null) {
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    
    // For non-admin users, filter by assigned_to
    const matchStage = {
      org_id: new mongoose.Types.ObjectId(orgId)
    };
    
    if (userId) {
      matchStage.assigned_to = typeof userId === 'string' 
        ? new mongoose.Types.ObjectId(userId)
        : userId;
    }
    
    const stats = await this.Complaint.aggregate([
      { $match: matchStage },
      {
        $facet: {
          total: [{ $count: 'count' }],
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          byCategory: [
            { $group: { _id: '$category', count: { $sum: 1 } } },
          ],
          byPriority: [
            { $group: { _id: '$priority', count: { $sum: 1 } } },
          ],
          bySubmissionMethod: [
            { $group: { _id: '$submission_method', count: { $sum: 1 } } },
          ],
          monthlyTrend: [
            {
              $match: {
                created_at: { $gte: sixMonthsAgo }
              }
            },
            {
              $group: {
                _id: { 
                  year: { $year: '$created_at' },
                  month: { $month: '$created_at' }
                },
                total: { $sum: 1 },
                resolved: {
                  $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] }
                }
              }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
          ],
          avgResolutionTime: [
            {
              $match: {
                status: 'resolved',
                updated_at: { $exists: true }
              }
            },
            {
              $project: {
                resolutionDays: {
                  $divide: [
                    { $subtract: ['$updated_at', '$created_at'] },
                    1000 * 60 * 60 * 24 // Convert milliseconds to days
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                avgDays: { $avg: '$resolutionDays' }
              }
            }
          ]
        },
      },
    ]);
    return stats[0];
  }
}

export class PublicComplaintLinkRepository {
  constructor(tenantDb) {
    this.PublicLink = tenantDb.models.PublicComplaintLink ||
      tenantDb.model('PublicComplaintLink', publicComplaintLinkSchema);
  }

  async create(linkData) {
    const link = await this.PublicLink.create(linkData);
    return link;
  }

  async findByToken(token) {
    return await this.PublicLink.findOne({ 
      link_token: token,
      is_active: true,
    }).populate('created_by', 'first_name last_name email');
  }

  async findByOrgId(orgId) {
    return await this.PublicLink.find({ org_id: orgId })
      .populate('created_by', 'first_name last_name email')
      .sort({ created_at: -1 });
  }

  async incrementSubmissionCount(token) {
    return await this.PublicLink.findOneAndUpdate(
      { link_token: token },
      { 
        $inc: { submission_count: 1 },
        updated_at: new Date()
      },
      { new: true }
    );
  }

  async deactivate(token) {
    return await this.PublicLink.findOneAndUpdate(
      { link_token: token },
      { 
        is_active: false,
        updated_at: new Date()
      },
      { new: true }
    );
  }
}
