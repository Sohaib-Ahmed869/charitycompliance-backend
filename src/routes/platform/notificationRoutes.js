/**
 * Notification Routes
 *
 * API routes for notifications
 */

import express from 'express';
import * as notificationController from '../../controllers/notificationController.js';
import { param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import pushSubscriptionSchema from '../../db/schemas/platform/pushSubscriptionSchema.js';
import { webPush as webPushConfig } from '../../config/index.js';

const router = express.Router();

// Lazily bind the PushSubscription model to the request's tenant DB.
const pushModel = (req) =>
  req.tenantDb.models.PushSubscription
  || req.tenantDb.model('PushSubscription', pushSubscriptionSchema);

router.use(authAndResolveTenant);

router.use((req, res, next) => {
  if (req.user?.isAuditor) {
    if (req.method === 'GET') {
      return res.json({ success: true, data: [], unreadCount: 0 });
    }
    return res.status(403).json({
      success: false,
      error: 'Notifications are not available for auditor access.'
    });
  }
  next();
});

router.get('/', notificationController.listNotifications);

// ── Web Push (browser notifications) ────────────────────────────────
// The VAPID public key the browser needs before it can subscribe.
router.get('/push/public-key', (req, res) => {
  res.json({ success: true, data: { publicKey: webPushConfig.vapidPublicKey || '' } });
});

// Register (or refresh) a browser's push subscription for this user.
router.post('/push/subscribe', asyncHandler(async (req, res) => {
  const sub = req.body?.subscription || req.body || {};
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ success: false, error: 'Invalid push subscription.' });
  }
  await pushModel(req).findOneAndUpdate(
    { endpoint },
    {
      $set: {
        user_id: req.user.userId,
        endpoint,
        keys_p256dh: p256dh,
        keys_auth: auth,
        user_agent: String(req.get('user-agent') || '').slice(0, 300)
      }
    },
    { upsert: true, new: true }
  );
  res.json({ success: true });
}));

// Drop a browser's push subscription (user turned notifications off).
router.post('/push/unsubscribe', asyncHandler(async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) {
    await pushModel(req).deleteOne({ endpoint }).catch(() => {});
  }
  res.json({ success: true });
}));

router.patch(
  '/:notificationId/read',
  [param('notificationId').isMongoId().withMessage('Invalid notification ID')],
  validate,
  notificationController.markAsRead
);

router.post('/read-all', notificationController.markAllAsRead);

router.patch(
  '/:notificationId/archive',
  [param('notificationId').isMongoId().withMessage('Invalid notification ID')],
  validate,
  notificationController.archiveNotification
);

router.patch(
  '/:notificationId/unarchive',
  [param('notificationId').isMongoId().withMessage('Invalid notification ID')],
  validate,
  notificationController.unarchiveNotification
);

router.delete(
  '/:notificationId',
  [param('notificationId').isMongoId().withMessage('Invalid notification ID')],
  validate,
  notificationController.deleteNotification
);

export default router;
