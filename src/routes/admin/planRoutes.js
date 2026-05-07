/**
 * SuperAdmin Plan & FeatureFlag routes (read-only — Sprint 1).
 *
 * Mounted at /api/v1/admin under the requireSuperAdmin gate. Returns the
 * Plan catalogue + the FeatureFlag catalogue — the data behind the
 * /calcite-admin pages. Writes (POST/PATCH/PUT) land in Sprint 2 alongside
 * the PlanRevision queue and the two-person approval workflow.
 *
 * Kept deliberately small: handlers are inline, no controller layer, no
 * service layer. The admin surface is going to grow (overrides, coupons,
 * audit, impersonation) and we'll grow the file structure when complexity
 * justifies it — not before.
 */

import express from 'express';
import { param } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';

const router = express.Router();

// All admin routes require auth + super-admin role. (Whoami lives in
// authRoutes.js at /admin/auth/me — keeps every public endpoint co-located.)
router.use(authenticate);
router.use(requireSuperAdmin);

// ── Plan catalogue ─────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/plans
 * List every plan in the catalogue. Returns the structured shape only —
 * legacy fields (monthly_price, yearly_price, features Mixed) are stripped
 * so the frontend can't accidentally render stale numbers.
 */
router.get('/plans', asyncHandler(async (req, res) => {
  const { SubscriptionPlan } = getRouterModels();
  const plans = await SubscriptionPlan
    .find({})
    .sort({ 'metadata.sortOrder': 1, plan_code: 1 })
    .lean();
  res.json({ success: true, data: plans.map(serializePlan) });
}));

/**
 * GET /api/v1/admin/plans/:code
 * Plan detail + revision history. Code is the slug (foundation /
 * professional / enterprise / custom-*).
 */
router.get(
  '/plans/:code',
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const plan = await SubscriptionPlan
      .findOne({ plan_code: String(req.params.code).toLowerCase() })
      .lean();
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'No such plan.' }
      });
    }
    const revisions = await PlanRevision
      .find({ plan_id: plan._id })
      .sort({ revision_number: -1 })
      .limit(50)
      .lean();
    res.json({
      success: true,
      data: { ...serializePlan(plan), revisions: revisions.map(serializeRevision) }
    });
  })
);

// ── Feature flag catalogue ─────────────────────────────────────────────

/**
 * GET /api/v1/admin/feature-flags
 * The flag catalogue — every gateable capability in Stewardex. Used by
 * the Plan detail Features tab to render the master checklist.
 */
router.get('/feature-flags', asyncHandler(async (req, res) => {
  const { FeatureFlag } = getRouterModels();
  const flags = await FeatureFlag
    .find({})
    .sort({ category: 1, code: 1 })
    .lean();
  res.json({ success: true, data: flags.map((f) => ({
    code: f.code,
    category: f.category,
    name: f.name,
    description: f.description || '',
    status: f.status
  })) });
}));

// ── Serialisers ────────────────────────────────────────────────────────
// Return only the structured shape the admin UI consumes. Mongoose Maps
// are returned as plain objects; legacy fields are dropped.

function serializePlan(p) {
  const featureFlags = p.feature_flags instanceof Map
    ? Object.fromEntries(p.feature_flags)
    : (p.feature_flags || {});
  return {
    _id: p._id,
    code: p.plan_code,
    name: p.plan_name,
    visibility: p.visibility || 'public',
    status: p.status || 'active',
    pricing: p.pricing || {},
    limits: p.limits || {},
    feature_flags: featureFlags,
    support: p.support || {},
    trial_days: p.trial_days ?? 14,
    metadata: p.metadata || {},
    current_revision: p.current_revision ?? 1,
    created_at: p.created_at,
    updated_at: p.updated_at
  };
}

function serializeRevision(r) {
  return {
    _id: r._id,
    revision_number: r.revision_number,
    diff: r.diff || [],
    reason: r.reason || '',
    changed_by: r.changed_by,
    changed_at: r.changed_at
  };
}

export default router;
