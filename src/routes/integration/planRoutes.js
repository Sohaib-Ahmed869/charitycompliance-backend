/**
 * Integration API — Subscription plans (CRUD) + feature-flag catalogue.
 *
 * Mounts the SuperAdmin plan handlers (routes/admin/planRoutes.js) behind the
 * API key, so every rule applies identically: the public-plan cap, automatic
 * Stripe product/price sync, and two-person approval — a dangerous PATCH
 * (price up, quota down, feature removed) or an archive returns
 * 202 { pending: true, approval_id } until a second super-admin approves it
 * in the admin portal. "Delete" archives; plans are never hard-deleted.
 */

import express from 'express';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  listPlansAction,
  getPlanAction,
  createPlanAction,
  patchPlanAction,
  archivePlanAction,
  listFeatureFlagsAction
} from '../admin/planRoutes.js';

const router = express.Router();

const codeParam = param('code').isString().trim().notEmpty();
const reasonRequired = body('reason').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Reason is required.');

/**
 * `__approvedReplay` is set internally when a second super-admin approves a
 * pending change. An API caller must never be able to send it and skip approval.
 */
const stripApprovalReplay = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') delete req.body.__approvedReplay;
  next();
};

router.get('/plans', asyncHandler(listPlansAction));

router.get('/plans/:code', [codeParam], validate, asyncHandler(getPlanAction));

router.post(
  '/plans',
  stripApprovalReplay,
  [
    body('code').isString().trim().isLength({ min: 2, max: 64 }).matches(/^[a-z0-9][a-z0-9_-]*$/)
      .withMessage('code must be lowercase letters, digits, _ or - (2–64 chars)'),
    body('name').isString().trim().isLength({ min: 1, max: 80 })
  ],
  validate,
  asyncHandler(createPlanAction)
);

router.patch('/plans/:code', stripApprovalReplay, [codeParam, reasonRequired], validate, asyncHandler(patchPlanAction));

/** DELETE /plans/:code — archive (same handler as POST /admin/plans/:code/archive). */
router.delete('/plans/:code', stripApprovalReplay, [codeParam, reasonRequired], validate, asyncHandler(archivePlanAction));

router.get('/feature-flags', asyncHandler(listFeatureFlagsAction));

export default router;
