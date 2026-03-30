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

const router = express.Router();

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

router.patch(
  '/:notificationId/read',
  [param('notificationId').isMongoId().withMessage('Invalid notification ID')],
  validate,
  notificationController.markAsRead
);

router.post('/read-all', notificationController.markAllAsRead);

export default router;
