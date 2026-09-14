/**
 * Notification Repository
 *
 * Manages notification data operations
 */

import notificationSchema from '../db/schemas/platform/notificationSchema.js';
import { sendToUsers } from '../services/pushService.js';

/**
 * Map an in-app notification to the mobile app's deep-link contract
 * ({ screen, params } consumed by PushRegistrar — MOBILE_PUSH_NOTIFICATIONS_SPEC §6).
 * Unknown entity types land on the in-app Notifications screen.
 */
const ENTITY_SCREENS = {
  approval_request: 'ApprovalDetail',
  meeting: 'MeetingDetail',
  complaint: 'ComplaintDetail',
  risk: 'RiskDetail',
  policy: 'PolicyDetail',
  support_ticket: 'SupportTicketDetail',
  inquiry_record: 'InquiryRecord'
};

function mobileDeepLink(notification) {
  const entityType = notification.related_entity_type;
  const id = notification.related_entity_id ? String(notification.related_entity_id) : null;
  const screen = id && ENTITY_SCREENS[entityType];
  if (screen) {
    return { type: entityType, id, screen, params: { id } };
  }
  if (entityType === 'expense') return { type: 'expense', id, screen: 'Expenses', params: {} };
  if (entityType === 'training_program') return { type: 'training', id, screen: 'MyTraining', params: {} };
  return { type: notification.type, id, screen: 'Notifications', params: {} };
}

/**
 * Mirror freshly-created in-app notifications to the mobile app via Expo push.
 * Batches identical payloads (createMany fan-outs differ only by user) and is
 * fire-and-forget by contract — callers do not await it.
 */
async function mirrorToMobilePush(tenantDb, items) {
  const groups = new Map();
  for (const n of items) {
    if (!n?.user_id || !n.title) continue;
    const data = mobileDeepLink(n);
    const key = `${n.title}|${n.message || ''}|${data.screen}|${data.id || ''}`;
    const group = groups.get(key) || { title: n.title, body: n.message || '', data, userIds: [] };
    group.userIds.push(n.user_id);
    groups.set(key, group);
  }
  for (const { title, body, data, userIds } of groups.values()) {
    await sendToUsers(tenantDb, userIds, { title, body, data });
  }
}

export class NotificationRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.Notification = tenantDb.models.Notification ||
      tenantDb.model('Notification', notificationSchema);
  }

  async create(data) {
    const notification = new this.Notification(data);
    const saved = await notification.save();
    mirrorToMobilePush(this.tenantDb, [saved]).catch(() => {});
    return saved;
  }

  async createMany(items) {
    if (!items || items.length === 0) return [];
    const docs = await this.Notification.insertMany(items);
    mirrorToMobilePush(this.tenantDb, docs).catch(() => {});
    return docs;
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
