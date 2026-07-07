/**
 * SuperAdmin — global reminder cadence configuration.
 *
 * Mounted under /api/v1/admin. Reads/writes the GLOBAL reminder_configs
 * collection in the Router DB. For now the only configurable type is
 * 'approval' (the approval reminder scheduler reads it).
 *
 *   GET   /admin/reminder-config            → current approval config (creates default if none)
 *   PATCH /admin/reminder-config/approval   → { enabled?, offsets_hours?, max_reminders? }
 *
 * Auth: `authenticate` then `requireSuperAdmin` — same posture as plan editing.
 */

import express from 'express';
import { body } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  getApprovalReminderConfig,
  updateApprovalReminderConfig
} from '../../repositories/reminderConfigRepository.js';

const router = express.Router();

router.use(authenticate);
router.use(requireSuperAdmin);

function serialize(doc) {
  if (!doc) return null;
  return {
    reminder_type: doc.reminder_type,
    enabled: doc.enabled,
    offsets_hours: Array.isArray(doc.offsets_hours) ? doc.offsets_hours : [],
    max_reminders: doc.max_reminders,
    updated_by: doc.updated_by || null,
    updated_at: doc.updatedAt || null
  };
}

/** GET /admin/reminder-config — approval cadence (creates default if missing). */
router.get(
  '/reminder-config',
  asyncHandler(async (req, res) => {
    const doc = await getApprovalReminderConfig();
    res.json({ success: true, data: serialize(doc) });
  })
);

/** PATCH /admin/reminder-config/approval — update cadence. */
router.patch(
  '/reminder-config/approval',
  [
    body('enabled').optional().isBoolean(),
    body('offsets_hours').optional().isArray().withMessage('offsets_hours must be an array'),
    body('offsets_hours.*').optional().isFloat({ gt: 0 }).withMessage('offsets_hours must be positive numbers'),
    body('max_reminders').optional().isInt({ min: 0 }).withMessage('max_reminders must be a non-negative integer')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const doc = await updateApprovalReminderConfig(
      {
        enabled: req.body.enabled,
        offsets_hours: req.body.offsets_hours,
        max_reminders: req.body.max_reminders
      },
      req.user?.userId || null
    );
    res.json({ success: true, data: serialize(doc) });
  })
);

export default router;
