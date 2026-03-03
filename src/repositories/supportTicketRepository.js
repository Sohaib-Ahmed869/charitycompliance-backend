/**
 * Support Ticket Repository
 * 
 * Database operations for support tickets
 */

import supportTicketSchema from '../db/schemas/platform/supportTicketSchema.js';

export class SupportTicketRepository {
  constructor(tenantDb) {
    this.SupportTicket = tenantDb.models.SupportTicket ||
      tenantDb.model('SupportTicket', supportTicketSchema);
  }

  async create(data) {
    const ticket = new this.SupportTicket(data);
    return await ticket.save();
  }

  async findById(id) {
    return await this.SupportTicket.findById(id)
      .populate('reporter.user_id', 'first_name last_name email')
      .populate('assignee.user_id', 'first_name last_name email')
      .populate('comments.created_by', 'first_name last_name')
      .lean();
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    
    if (filters.status) query.status = filters.status;
    if (filters.priority) query.priority = filters.priority;
    if (filters.assignee) query['assignee.user_id'] = filters.assignee;
    if (filters.category) query.category = filters.category;

    return await this.SupportTicket.find(query)
      .populate('reporter.user_id', 'first_name last_name email')
      .populate('assignee.user_id', 'first_name last_name email')
      .sort({ created_at: -1 })
      .lean();
  }

  async findByTicketNumber(ticketNumber) {
    return await this.SupportTicket.findOne({ ticket_number: ticketNumber })
      .populate('reporter.user_id', 'first_name last_name email')
      .populate('assignee.user_id', 'first_name last_name email')
      .lean();
  }

  async update(id, data) {
    return await this.SupportTicket.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true }
    ).lean();
  }

  async delete(id) {
    return await this.SupportTicket.findByIdAndDelete(id);
  }

  async getStats(orgId) {
    const [statusCounts, priorityCounts, totalCount, satisfactionStats] = await Promise.all([
      this.SupportTicket.aggregate([
        { $match: { org_id: orgId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      this.SupportTicket.aggregate([
        { $match: { org_id: orgId } },
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ]),
      this.SupportTicket.countDocuments({ org_id: orgId }),
      this.SupportTicket.aggregate([
        { $match: { org_id: orgId, satisfaction_rating: { $exists: true, $ne: null } } },
        { 
          $group: { 
            _id: null, 
            avgRating: { $avg: '$satisfaction_rating' },
            totalRatings: { $sum: 1 },
            positiveCount: { 
              $sum: { $cond: [{ $gte: ['$satisfaction_rating', 4] }, 1, 0] } 
            },
            negativeCount: { 
              $sum: { $cond: [{ $lte: ['$satisfaction_rating', 2] }, 1, 0] } 
            },
            neutralCount: { 
              $sum: { $cond: [{ $and: [{ $gte: ['$satisfaction_rating', 3] }, { $lte: ['$satisfaction_rating', 3] }] }, 1, 0] } 
            }
          } 
        }
      ])
    ]);

    return {
      statusCounts: statusCounts.reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {}),
      priorityCounts: priorityCounts.reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {}),
      totalCount,
      satisfaction: satisfactionStats[0] || { avgRating: 0, totalRatings: 0, positiveCount: 0, negativeCount: 0, neutralCount: 0 }
    };
  }

  async getTrendData(orgId, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return await this.SupportTicket.aggregate([
      { 
        $match: { 
          org_id: orgId,
          created_at: { $gte: startDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          total: { $sum: 1 },
          resolved: { 
            $sum: { $cond: [{ $eq: ['$status', 'solved'] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);
  }

  async generateTicketNumber(orgId) {
    const count = await this.SupportTicket.countDocuments({ org_id: orgId });
    const prefix = 'TKT';
    const number = String(count + 1).padStart(5, '0');
    return `${prefix}${number}`;
  }

  async getRegionStats(orgId) {
    const result = await this.SupportTicket.aggregate([
      { $match: { org_id: orgId, 'reporter.country_code': { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$reporter.country_code',
          country: { $first: '$reporter.country' },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const total = result.reduce((sum, r) => sum + r.count, 0) || 1;

    return result.map(r => ({
      country_code: r._id,
      country: r.country || r._id,
      count: r.count,
      percentage: Math.round((r.count / total) * 100)
    }));
  }
}
