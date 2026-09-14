/**
 * Member Routes — /api/v1/platform/members
 *
 * All routes are tenant-scoped (authAndResolveTenant). Writes are gated on
 * `module:members:edit` (the permission model synthesises view/edit/delete;
 * create maps to edit), reads on `module:members:view`.
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import * as memberController from '../../controllers/memberController.js';

const MEMBERSHIP_TYPES = ['individual', 'organisation', 'life', 'honorary', 'student', 'associate', 'other'];

const router = express.Router();
router.use(authAndResolveTenant);

// ─── List + counts ─────────────────────────────────────────────────────
router.get(
  '/',
  [
    query('status').optional().isIn(['approved', 'pending_approval', 'rejected']),
    query('membership_type').optional().isIn(MEMBERSHIP_TYPES),
    query('is_active').optional().isBoolean().toBoolean(),
    query('search').optional().trim()
  ],
  validate,
  requirePermission('module:members:view'),
  memberController.listMembers
);

router.get(
  '/counts',
  requirePermission('module:members:view'),
  memberController.getMemberCounts
);

// ─── Single member ─────────────────────────────────────────────────────
router.get(
  '/:memberId',
  [param('memberId').isMongoId().withMessage('Invalid member ID')],
  validate,
  requirePermission('module:members:view'),
  memberController.getMemberById
);

// ─── Create / update / delete ──────────────────────────────────────────
router.post(
  '/',
  [
    body('full_name').trim().notEmpty().withMessage('Full name is required'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Email must be valid'),
    body('membership_type').optional().isIn(MEMBERSHIP_TYPES),
    body('date_joined').optional({ checkFalsy: true }).isISO8601()
  ],
  validate,
  requirePermission('module:members:edit'),
  memberController.createMember
);

router.put(
  '/:memberId',
  [
    param('memberId').isMongoId(),
    body('full_name').optional().trim().notEmpty(),
    body('email').optional({ checkFalsy: true }).isEmail(),
    body('membership_type').optional().isIn(MEMBERSHIP_TYPES),
    body('date_joined').optional({ checkFalsy: true }).isISO8601(),
    body('is_active').optional().isBoolean()
  ],
  validate,
  requirePermission('module:members:edit'),
  memberController.updateMember
);

router.delete(
  '/:memberId',
  [param('memberId').isMongoId()],
  validate,
  requirePermission('module:members:delete'),
  memberController.deleteMember
);

export default router;
