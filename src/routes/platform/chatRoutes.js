/**
 * Chat Routes
 *
 * Mounted at /api/v1/platform/chat. Auth + tenant resolution via authAndResolveTenant.
 * Auditors get read-only via the existing isAuditor permissions and the global
 * frontend axios interceptor that blocks mutations on /platform/*.
 */

import express from 'express';
import { param, body } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadMultiple, handleUploadError } from '../../middleware/upload.js';
import * as chat from '../../controllers/chatController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/channels', chat.listChannels);

router.get(
  '/channels/:channelId/messages',
  [param('channelId').isMongoId().withMessage('Invalid channel id')],
  validate,
  chat.listMessages
);

router.post(
  '/channels/:channelId/messages',
  [
    param('channelId').isMongoId().withMessage('Invalid channel id'),
    // Body OR attachments must be present — repository enforces this; here we just cap body length.
    body('body').optional({ checkFalsy: true }).isString().isLength({ max: 8000 }),
    body('attachments').optional().isArray()
  ],
  validate,
  chat.postMessage
);

router.post(
  '/channels/:channelId/read',
  [param('channelId').isMongoId().withMessage('Invalid channel id')],
  validate,
  chat.markRead
);

router.patch(
  '/messages/:messageId',
  [
    param('messageId').isMongoId().withMessage('Invalid message id'),
    body('body').isString().trim().notEmpty().withMessage('Message body is required').isLength({ max: 8000 })
  ],
  validate,
  chat.editMessage
);

router.delete(
  '/messages/:messageId',
  [param('messageId').isMongoId().withMessage('Invalid message id')],
  validate,
  chat.deleteMessage
);

// Reactions
router.post(
  '/messages/:messageId/reactions',
  [
    param('messageId').isMongoId(),
    body('emoji').isString().trim().notEmpty().isLength({ max: 32 })
  ],
  validate,
  chat.toggleReaction
);

// Pin (admin only — guard inside controller)
router.post(
  '/messages/:messageId/pin',
  [param('messageId').isMongoId(), body('pinned').optional().isBoolean()],
  validate,
  chat.setPin
);
router.get(
  '/channels/:channelId/pinned',
  [param('channelId').isMongoId()],
  validate,
  chat.listPinned
);

// Star (personal)
router.post(
  '/messages/:messageId/star',
  [param('messageId').isMongoId(), body('starred').optional().isBoolean()],
  validate,
  chat.setStar
);
router.get('/me/starred', chat.listStarred);

// Mention picker
router.get('/users', chat.listMentionableUsers);

// Compliance mention search (modules + entities)
router.get('/compliance/search', chat.searchCompliance);

// File attachments upload — multipart/form-data with `files` field (multer.array)
router.post(
  '/channels/:channelId/upload',
  [param('channelId').isMongoId()],
  validate,
  uploadMultiple,
  handleUploadError,
  chat.uploadAttachments
);

// Channel CRUD
router.post(
  '/channels',
  [
    body('name').isString().trim().notEmpty().isLength({ max: 80 }),
    body('memberUserIds').optional().isArray()
  ],
  validate,
  chat.createChannel
);
router.patch(
  '/channels/:channelId',
  [
    param('channelId').isMongoId(),
    body('name').optional().isString().trim().isLength({ max: 80 }),
    body('description').optional().isString().isLength({ max: 500 }),
    body('retention_days').optional().isInt({ min: 0, max: 3650 })
  ],
  validate,
  chat.updateChannel
);
router.post(
  '/channels/:channelId/members',
  [param('channelId').isMongoId(), body('userIds').isArray({ min: 1 })],
  validate,
  chat.addMembers
);
router.delete(
  '/channels/:channelId/members/:userId',
  [param('channelId').isMongoId(), param('userId').isMongoId()],
  validate,
  chat.removeMember
);

export default router;
