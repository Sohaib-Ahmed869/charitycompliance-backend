/**
 * Notification Repository
 *
 * Manages notification data operations
 */

import notificationSchema from '../db/schemas/platform/notificationSchema.js';

export class NotificationRepository {
  constructor(tenantDb) {
    this.Notification = tenantDb.models.Notification ||
      tenantDb.model('Notification', notificationSchema);
  }

  async create(data) {
    const notification = new this.Notification(data);
    return await notification.save();
  }

  async createMany(items) {
    if (!items || items.length === 0) return [];
    return await this.Notification.insertMany(items);
  }

  async findByUserId(userId, options = {}) {
    const { limit = 50, unreadOnly = false } = options;
    const query = { user_id: userId };
    if (unreadOnly) query.read = false;
    return await this.Notification.find(query)
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
  }

  async markAsRead(id, userId) {
    return await this.Notification.findOneAndUpdate(
      { _id: id, user_id: userId },
      { $set: { read: true } },
      { new: true }
    );
  }

  async markAllAsRead(userId) {
    const result = await this.Notification.updateMany(
      { user_id: userId, read: false },
      { $set: { read: true } }
    );
    return result.modifiedCount;
  }

  async getUnreadCount(userId) {
    return await this.Notification.countDocuments({ user_id: userId, read: false });
  }
}
