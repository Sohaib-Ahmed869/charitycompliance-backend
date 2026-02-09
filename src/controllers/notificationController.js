/**
 * Notification Controller
 *
 * Handles HTTP requests for notifications
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';

export const listNotifications = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { unreadOnly, limit } = req.query;

  const tenantDb = await getTenantConnection(orgId);
  const notificationRepo = new NotificationRepository(tenantDb);

  const notifications = await notificationRepo.findByUserId(userId, {
    unreadOnly: unreadOnly === 'true',
    limit: limit ? Math.min(parseInt(limit, 10) || 50, 100) : 50
  });

  const unreadCount = await notificationRepo.getUnreadCount(userId);

  res.json({
    success: true,
    data: notifications,
    unreadCount
  });
});

export const markAsRead = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { notificationId } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const notificationRepo = new NotificationRepository(tenantDb);

  const updated = await notificationRepo.markAsRead(notificationId, userId);
  if (!updated) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Notification not found' }
    });
  }

  res.json({ success: true, data: updated });
});

export const markAllAsRead = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;

  const tenantDb = await getTenantConnection(orgId);
  const notificationRepo = new NotificationRepository(tenantDb);

  const count = await notificationRepo.markAllAsRead(userId);

  res.json({ success: true, data: { markedCount: count } });
});
