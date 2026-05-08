/**
 * SuperAdmin plan & feature-flag endpoints.
 *
 * Plans live as a hybrid: in-code defaults (Foundation/Professional/
 * Enterprise) merged at GET time with whatever real Plan documents exist
 * in the Router DB. Editing a default materialises it — first save creates
 * the SubscriptionPlan document and revision 1. Subsequent saves create
 * incremental PlanRevisions with a computed diff.
 *
 * No service or controller layer yet — handlers stay inline. The admin
 * surface is intentionally small until we earn more complexity.
 */

import express from 'express';
import { body, param } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
// NOTE: Plan PATCH does NOT bust tenant entitlement caches by design —
// pinning means existing tenants keep their old revision until a SuperAdmin
// runs POST /admin/plans/:code/migrate-revision (see opsRoutes.js).
import {
  DEFAULT_PLANS,
  DEFAULT_FEATURE_FLAGS,
  mergePlansWithTemplates,
  findTemplateByCode,
  feature_flags_default_map
} from '../../utils/defaultPlans.js';

const router = express.Router();

router.use(authenticate);
router.use(requireSuperAdmin);

// ── Plans ─────────────────────────────────────────────────────────────

/** GET /admin/plans — DB plans + templates, sorted by sortOrder. */
router.get('/plans', asyncHandler(async (req, res) => {
  const { SubscriptionPlan } = getRouterModels();
  const dbPlans = await SubscriptionPlan
    .find({})
    .sort({ 'metadata.sortOrder': 1, plan_code: 1 })
    .lean();
  const merged = mergePlansWithTemplates(dbPlans.map(serializePlan));
  res.json({ success: true, data: merged });
}));

/** GET /admin/plans/:code — DB plan + revisions, or template if not yet saved. */
router.get(
  '/plans/:code',
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const plan = await SubscriptionPlan.findOne({ plan_code: code }).lean();
    if (plan) {
      const revisions = await PlanRevision
        .find({ plan_id: plan._id })
        .sort({ revision_number: -1 })
        .limit(50)
        .lean();
      return res.json({
        success: true,
        data: { ...serializePlan(plan), is_template: false, revisions: revisions.map(serializeRevision) }
      });
    }
    // Not yet saved — return the template (if any) so the UI can render it.
    const template = findTemplateByCode(code);
    if (template) {
      return res.json({
        success: true,
        data: { ...template, _id: null, is_template: true, current_revision: 0, revisions: [] }
      });
    }
    return res.status(404).json({
      success: false,
      error: { code: 'PLAN_NOT_FOUND', message: 'No such plan.' }
    });
  })
);

/**
 * PATCH /admin/plans/:code — apply a structured patch.
 *
 * Body is the full new plan shape (pricing/limits/feature_flags/support/
 * trial_days/metadata/visibility/status/name). We compute a diff against
 * the previous snapshot, persist a new PlanRevision, and update the Plan.
 * If the plan was a template (no DB record yet), this is the
 * materialisation moment — we create the document and revision 1.
 */
router.patch(
  '/plans/:code',
  [
    param('code').isString().trim().notEmpty(),
    body('reason').optional().isString()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const patch = req.body || {};
    const reason = String(patch.reason || '').trim();
    const editorId = req.user?.userId || null;

    const editable = ['name', 'visibility', 'status', 'pricing', 'limits', 'feature_flags', 'support', 'trial_days', 'metadata'];
    const cleaned = {};
    for (const k of editable) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) cleaned[k] = patch[k];
    }

    // Map structured fields → schema field names.
    const update = {};
    if (cleaned.name) update.plan_name = cleaned.name;
    if (cleaned.visibility) update.visibility = cleaned.visibility;
    if (cleaned.status) update.status = cleaned.status;
    if (cleaned.pricing) update.pricing = cleaned.pricing;
    if (cleaned.limits) update.limits = cleaned.limits;
    if (cleaned.feature_flags) update.feature_flags = cleaned.feature_flags;
    if (cleaned.support) update.support = cleaned.support;
    if (cleaned.trial_days != null) update.trial_days = cleaned.trial_days;
    if (cleaned.metadata) update.metadata = cleaned.metadata;
    // Mirror legacy fields so any old reader stays correct.
    if (cleaned.pricing?.monthlyAUD != null) update.monthly_price = Number(cleaned.pricing.monthlyAUD);
    if (cleaned.pricing?.annualAUD != null) update.yearly_price = Number(cleaned.pricing.annualAUD);

    let plan = await SubscriptionPlan.findOne({ plan_code: code });
    let prevSnapshot = null;
    let nextRevisionNumber = 1;

    if (!plan) {
      // First materialisation — must come from a template OR be a brand-new
      // custom plan (handled by POST /plans, not here).
      const template = findTemplateByCode(code);
      if (!template) {
        return res.status(404).json({
          success: false,
          error: { code: 'PLAN_NOT_FOUND', message: 'No template or saved plan with that code.' }
        });
      }
      const initial = templateToDocument(template);
      Object.assign(initial, update);
      initial.plan_code = code;
      initial.current_revision = 1;
      initial.updated_by = editorId;
      plan = await SubscriptionPlan.create(initial);
    } else {
      prevSnapshot = serializePlan(plan.toObject());
      nextRevisionNumber = (plan.current_revision || 0) + 1;
      Object.assign(plan, update);
      plan.current_revision = nextRevisionNumber;
      plan.updated_by = editorId;
      // feature_flags is Mixed — Mongoose doesn't auto-detect deep replacement.
      if (cleaned.feature_flags) plan.markModified('feature_flags');
      await plan.save();
    }

    const newSnapshot = serializePlan(plan.toObject());
    const diff = computeDiff(prevSnapshot, newSnapshot);

    await PlanRevision.create({
      plan_id: plan._id,
      plan_code: plan.plan_code,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      diff,
      reason,
      changed_by: editorId,
      changed_at: new Date()
    });

    const revisions = await PlanRevision
      .find({ plan_id: plan._id })
      .sort({ revision_number: -1 })
      .limit(50)
      .lean();

    // Audit: distinguish materialisation from regular update.
    await writeBillingEvent(req, {
      action: prevSnapshot ? 'plan.updated' : 'plan.materialised',
      targetType: 'plan',
      targetId: plan.plan_code,
      targetLabel: plan.plan_name,
      diff,
      reason,
      metadata: { revision: nextRevisionNumber }
    });

    return res.json({
      success: true,
      data: { ...newSnapshot, is_template: false, revisions: revisions.map(serializeRevision) }
    });
  })
);

/**
 * POST /admin/plans — create a brand-new custom plan from scratch (or
 * forked from another). Body must include at least `code` + `name`.
 */
router.post(
  '/plans',
  [
    body('code').isString().trim().isLength({ min: 2, max: 64 }).matches(/^[a-z0-9][a-z0-9_-]*$/),
    body('name').isString().trim().isLength({ min: 1, max: 80 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.body.code).toLowerCase().trim();
    const name = String(req.body.name).trim();

    const exists = await SubscriptionPlan.findOne({ plan_code: code });
    if (exists) {
      return res.status(409).json({
        success: false,
        error: { code: 'PLAN_CODE_TAKEN', message: 'A plan with that code already exists.' }
      });
    }
    if (findTemplateByCode(code)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'PLAN_CODE_RESERVED',
          message: 'That code is reserved for a default template — edit the template instead.'
        }
      });
    }

    // Optional fork: copy fields from another plan (template or DB).
    const forkFromCode = String(req.body.fork_from || '').toLowerCase().trim();
    let base = null;
    if (forkFromCode) {
      const forkDb = await SubscriptionPlan.findOne({ plan_code: forkFromCode }).lean();
      base = forkDb ? serializePlan(forkDb) : findTemplateByCode(forkFromCode);
    }
    const initial = base ? templateToDocument(base) : blankPlanDocument();
    initial.plan_code = code;
    initial.plan_name = name;
    initial.visibility = req.body.visibility || initial.visibility || 'private';
    initial.status = 'active';
    initial.current_revision = 1;
    initial.updated_by = req.user?.userId || null;

    const created = await SubscriptionPlan.create(initial);
    const snapshot = serializePlan(created.toObject());
    await PlanRevision.create({
      plan_id: created._id,
      plan_code: created.plan_code,
      revision_number: 1,
      snapshot,
      diff: [],
      reason: forkFromCode ? `Created (forked from ${forkFromCode}).` : 'Created.',
      changed_by: req.user?.userId || null,
      changed_at: new Date()
    });
    await writeBillingEvent(req, {
      action: 'plan.created',
      targetType: 'plan',
      targetId: created.plan_code,
      targetLabel: created.plan_name,
      reason: forkFromCode ? `Forked from ${forkFromCode}.` : 'Created.',
      metadata: { fork_from: forkFromCode || null }
    });

    return res.status(201).json({
      success: true,
      data: { ...snapshot, is_template: false, revisions: [] }
    });
  })
);

/** POST /admin/plans/:code/archive — flip status to archived. */
router.post(
  '/plans/:code/archive',
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const plan = await SubscriptionPlan.findOne({ plan_code: code });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'Cannot archive a plan that has never been saved.' }
      });
    }
    const prev = serializePlan(plan.toObject());
    plan.status = 'archived';
    plan.is_active = false;
    plan.current_revision = (plan.current_revision || 0) + 1;
    plan.updated_by = req.user?.userId || null;
    await plan.save();
    const next = serializePlan(plan.toObject());
    await PlanRevision.create({
      plan_id: plan._id,
      plan_code: plan.plan_code,
      revision_number: plan.current_revision,
      snapshot: next,
      diff: computeDiff(prev, next),
      reason: 'Archived.',
      changed_by: req.user?.userId || null,
      changed_at: new Date()
    });
    await writeBillingEvent(req, {
      action: 'plan.archived',
      targetType: 'plan',
      targetId: plan.plan_code,
      targetLabel: plan.plan_name,
      reason: 'Archived.'
    });
    return res.json({ success: true, data: { ...next, is_template: false } });
  })
);

// ── Feature flags ─────────────────────────────────────────────────────

/**
 * GET /admin/feature-flags — DB-backed catalogue, with the in-code
 * defaults filling in anything not yet persisted. Same template-merge
 * pattern as plans, so a fresh DB just shows the canonical 40 flags.
 */
router.get('/feature-flags', asyncHandler(async (req, res) => {
  const { FeatureFlag } = getRouterModels();
  const dbFlags = await FeatureFlag.find({}).sort({ category: 1, code: 1 }).lean();
  const byCode = new Map(dbFlags.map((f) => [f.code, f]));
  const merged = DEFAULT_FEATURE_FLAGS.map(([code, category, name, , description]) => {
    const db = byCode.get(code);
    return db
      ? { code: db.code, category: db.category, name: db.name, description: db.description || description || '', status: db.status, is_template: false }
      : { code, category, name, description: description || '', status: 'active', is_template: true };
  });
  // Surface any DB-only flags (custom-added beyond the catalogue) at the end.
  for (const db of dbFlags) {
    if (!merged.some((m) => m.code === db.code)) {
      merged.push({ code: db.code, category: db.category, name: db.name, description: db.description || '', status: db.status, is_template: false });
    }
  }
  res.json({ success: true, data: merged });
}));

// ── Helpers ───────────────────────────────────────────────────────────

function serializePlan(p) {
  if (!p) return null;
  const featureFlags = p.feature_flags instanceof Map
    ? Object.fromEntries(p.feature_flags)
    : (p.feature_flags || {});
  return {
    _id: p._id || null,
    code: p.plan_code || p.code,
    name: p.plan_name || p.name,
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

/** Convert a template (or another plan) into the SubscriptionPlan document shape. */
function templateToDocument(t) {
  return {
    plan_code: t.code,
    plan_name: t.name,
    visibility: t.visibility || 'public',
    status: t.status || 'active',
    is_active: (t.status || 'active') === 'active',
    pricing: { ...(t.pricing || {}) },
    limits: { ...(t.limits || {}) },
    feature_flags: { ...(t.feature_flags || {}) },
    support: { ...(t.support || {}) },
    trial_days: t.trial_days ?? 14,
    metadata: { ...(t.metadata || {}) },
    monthly_price: Number(t.pricing?.monthlyAUD || 0),
    yearly_price: Number(t.pricing?.annualAUD || 0)
  };
}

/** Skeleton for a brand-new custom plan (POST /admin/plans without fork). */
function blankPlanDocument() {
  return {
    plan_code: '',
    plan_name: '',
    visibility: 'private',
    status: 'active',
    is_active: true,
    pricing: { monthlyAUD: 0, annualAUD: 0, setupFeeMonthlyAUD: 0, setupFeeAnnualAUD: 0, overagePerWorkflowAUD: null, currency: 'AUD' },
    limits: { staffSeats: 5, boardSeats: 5, workflowsPerMonth: 50, storageGB: 10, apiCallsPerDay: 0, customWorkflows: 0, childEntities: 0, softCapPct: 80, hardCapPct: 100 },
    feature_flags: feature_flags_default_map(),
    support: { channel: 'email', responseSLAHours: 48, uptimeSLAPct: null },
    trial_days: 14,
    metadata: { description: '', targetCustomer: '', sortOrder: 100 },
    monthly_price: 0,
    yearly_price: 0
  };
}

/**
 * Compute a flat diff list of [path, from, to] tuples between two plan
 * snapshots. Recursive on nested objects (pricing/limits/etc.); short-
 * circuits on equal scalars and equal JSON-stringified subtrees.
 */
function computeDiff(prev, next, prefix = '') {
  if (!prev) return [];
  const out = [];
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const k of keys) {
    if (k === 'revisions' || k === '_id' || k === 'is_template' || k === 'created_at' || k === 'updated_at' || k === 'current_revision') continue;
    const a = prev?.[k];
    const b = next?.[k];
    const path = prefix ? `${prefix}.${k}` : k;
    const aJson = JSON.stringify(a);
    const bJson = JSON.stringify(b);
    if (aJson === bJson) continue;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      out.push(...computeDiff(a, b, path));
    } else {
      out.push({ path, from: a ?? null, to: b ?? null });
    }
  }
  return out;
}

export default router;
