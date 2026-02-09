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

router.get('/', notificationController.listNotifications);

router.patch(
  '/:notificationId/read',
  [param('notificationId').isMongoId().withMessage('Invalid notification ID')],
  validate,
  notificationController.markAsRead
);

router.post('/read-all', notificationController.markAllAsRead);

export default router;
