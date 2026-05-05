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
    const { limit = 50, unreadOnly = false, archived = false } = options;
    const query = { user_id: userId };
    if (unreadOnly) query.read = false;
    // Archived state — hide archived items from the main list by default,
    // and surface them only when explicitly requested.
    if (archived === true) {
      query.archived = true;
    } else {
      query.$or = [{ archived: { $exists: false } }, { archived: false }];
    }
    return await this.Notification.find(query)
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
  }

  async archive(id, userId) {
    return await this.Notification.findOneAndUpdate(
      { _id: id, user_id: userId },
      { $set: { archived: true, archived_at: new Date() } },
      { new: true }
    );
  }

  async unarchive(id, userId) {
    return await this.Notification.findOneAndUpdate(
      { _id: id, user_id: userId },
      { $set: { archived: false }, $unset: { archived_at: 1 } },
      { new: true }
    );
  }

  async deleteById(id, userId) {
    return await this.Notification.findOneAndDelete({ _id: id, user_id: userId });
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

  /**
   * Basic dedupe helper: has a similar notification been created today?
   * Used for scheduled reminders to avoid duplicates on restarts.
   */
  async existsToday({ user_id, type, related_entity_id, message_contains }) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const query = {
      user_id,
      type,
      related_entity_id,
      created_at: { $gte: start, $lt: end }
    };
    if (message_contains) {
      query.message = { $regex: message_contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    const found = await this.Notification.findOne(query).select('_id').lean();
    return !!found;
  }
}
