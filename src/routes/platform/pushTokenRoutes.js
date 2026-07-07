/**
 * Push Token Routes (mobile Expo push registration)
 *
 * MOBILE_PUSH_NOTIFICATIONS_SPEC.md §3. Mounted at
 * `/api/v1/platform/push-tokens` behind `authAndResolveTenant`. No feature-flag
 * gate — push is cross-cutting.
 *
 *   POST   /platform/push-tokens   { token, platform?, device_id?, app_version? }
 *   DELETE /platform/push-tokens   { token }
 *
 * The controller is intentionally thin: the token owner is always the caller
 * (`req.user.userId`), never trusted from the body.
 */

import express from 'express';
import { body } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { PushTokenRepository } from '../../repositories/pushTokenRepository.js';

const router = express.Router();

router.use(authAndResolveTenant);

// Register / refresh the caller's Expo push token.
router.post(
  '/',
  [
    body('token').isString().notEmpty().matches(/^Expo(nent)?PushToken\[/)
      .withMessage('token must be a valid Expo push token'),
    body('platform').optional().isIn(['ios', 'android', 'web']),
    body('device_id').optional({ nullable: true }).isString(),
    body('app_version').optional({ nullable: true }).isString()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const repo = new PushTokenRepository(req.tenantDb);
    await repo.upsert({
      user_id: req.user.userId,
      token: req.body.token,
      platform: req.body.platform,
      device_id: req.body.device_id ?? null,
      app_version: req.body.app_version ?? null
    });
    return res.status(201).json({ success: true });
  })
);

// Unregister a token (logout / permission revoked).
router.delete(
  '/',
  [body('token').isString().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const repo = new PushTokenRepository(req.tenantDb);
    // Scope the delete to the caller so a user can only drop their own token.
    await repo.removeForUserDevice(req.user.userId, req.body.token);
    return res.status(200).json({ success: true });
  })
);

export default router;
