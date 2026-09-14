/**
 * Integration API — Subscription plans (CRUD) + feature-flag catalogue.
 *
 * Same hybrid model as the SuperAdmin portal (routes/admin/planRoutes.js):
 * in-code templates (Foundation/Professional/Enterprise) merged with saved
 * Plan documents. The first PATCH on a template materialises it; every save
 * writes a PlanRevision with a computed diff. "Delete" archives — plans are
 * referenced by subscriptions and revisions, so they are never hard-deleted.
 */

import express from 'express';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
import {
  DEFAULT_FEATURE_FLAGS,
  mergePlansWithTemplates,
  findTemplateByCode
} from '../../utils/defaultPlans.js';
import {
  serializePlan,
  serializeRevision,
  templateToDocument,
  blankPlanDocument,
  computeDiff
} from '../admin/planRoutes.js';

const router = express.Router();

const codeParam = param('code').isString().trim().notEmpty();
const planBodyRules = [
  body('name').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('visibility').optional().isIn(['public', 'private']),
  body('status').optional().isIn(['active', 'archived']),
  body('pricing').optional().isObject(),
  body('limits').optional().isObject(),
  body('feature_flags').optional().isObject(),
  body('support').optional().isObject(),
  body('metadata').optional().isObject(),
  body('trial_days').optional().isInt({ min: 0, max: 365 }),
  body('reason').optional().isString()
];

const planNotFound = (res, message = 'No such plan.') => res.status(404).json({
  success: false,
  error: { code: 'PLAN_NOT_FOUND', message }
});

async function recentRevisions(planId) {
  const { PlanRevision } = getRouterModels();
  const revisions = await PlanRevision.find({ plan_id: planId }).sort({ revision_number: -1 }).limit(50).lean();
  return revisions.map(serializeRevision);
}

/** Map the public plan shape onto SubscriptionPlan fields (+ legacy price mirrors). */
function toPlanUpdate(patch) {
  const update = {};
  if (patch.name) update.plan_name = patch.name;
  for (const k of ['visibility', 'status', 'pricing', 'limits', 'feature_flags', 'support', 'metadata']) {
    if (patch[k] != null) update[k] = patch[k];
  }
  if (patch.trial_days != null) update.trial_days = Number(patch.trial_days);
  if (patch.status) update.is_active = patch.status === 'active';
  if (patch.pricing?.monthlyAUD != null) update.monthly_price = Number(patch.pricing.monthlyAUD);
  if (patch.pricing?.annualAUD != null) update.yearly_price = Number(patch.pricing.annualAUD);
  return update;
}

/** GET /plans — saved plans + unsaved templates, sorted by sortOrder. */
router.get('/plans', asyncHandler(async (req, res) => {
  const { SubscriptionPlan } = getRouterModels();
  const dbPlans = await SubscriptionPlan.find({}).sort({ 'metadata.sortOrder': 1, plan_code: 1 }).lean();
  res.json({ success: true, data: mergePlansWithTemplates(dbPlans.map(serializePlan)) });
}));

/** GET /plans/:code — plan + revision history (or the template if never saved). */
router.get(
  '/plans/:code',
  [codeParam],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const plan = await SubscriptionPlan.findOne({ plan_code: code }).lean();
    if (plan) {
      return res.json({
        success: true,
        data: { ...serializePlan(plan), is_template: false, revisions: await recentRevisions(plan._id) }
      });
    }
    const template = findTemplateByCode(code);
    if (!template) return planNotFound(res);
    res.json({ success: true, data: { ...template, _id: null, is_template: true, current_revision: 0, revisions: [] } });
  })
);

/** POST /plans — { code, name, fork_from?, visibility?, pricing?, limits?, … }. */
router.post(
  '/plans',
  [
    body('code').isString().trim().isLength({ min: 2, max: 64 }).matches(/^[a-z0-9][a-z0-9_-]*$/)
      .withMessage('code must be lowercase letters, digits, _ or - (2–64 chars)'),
    body('name').isString().trim().isLength({ min: 1, max: 80 }),
    body('fork_from').optional().isString().trim(),
    ...planBodyRules
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.body.code).toLowerCase().trim();

    if (await SubscriptionPlan.exists({ plan_code: code })) {
      return res.status(409).json({
        success: false,
        error: { code: 'PLAN_CODE_TAKEN', message: 'A plan with that code already exists.' }
      });
    }
    if (findTemplateByCode(code)) {
      return res.status(409).json({
        success: false,
        error: { code: 'PLAN_CODE_RESERVED', message: 'That code is reserved for a default template — PATCH it instead.' }
      });
    }

    const forkFromCode = String(req.body.fork_from || '').toLowerCase().trim();
    let base = null;
    if (forkFromCode) {
      const forkDb = await SubscriptionPlan.findOne({ plan_code: forkFromCode }).lean();
      base = forkDb ? serializePlan(forkDb) : findTemplateByCode(forkFromCode);
      if (!base) return planNotFound(res, `fork_from plan "${forkFromCode}" does not exist.`);
    }

    const initial = {
      ...(base ? templateToDocument(base) : blankPlanDocument()),
      ...toPlanUpdate(req.body),
      plan_code: code,
      plan_name: String(req.body.name).trim(),
      visibility: req.body.visibility || base?.visibility || 'private',
      status: 'active',
      is_active: true,
      current_revision: 1,
      updated_by: null
    };

    const created = await SubscriptionPlan.create(initial);
    const snapshot = serializePlan(created.toObject());
    const reason = forkFromCode ? `Created (forked from ${forkFromCode}).` : 'Created.';
    await PlanRevision.create({
      plan_id: created._id,
      plan_code: created.plan_code,
      revision_number: 1,
      snapshot,
      diff: [],
      reason,
      changed_by: null,
      changed_at: new Date()
    });
    await writeBillingEvent(req, {
      action: 'plan.created',
      targetType: 'plan',
      targetId: created.plan_code,
      targetLabel: created.plan_name,
      reason,
      metadata: { fork_from: forkFromCode || null }
    });

    res.status(201).json({ success: true, data: { ...snapshot, is_template: false, revisions: [] } });
  })
);

/**
 * PATCH /plans/:code — partial update of name/visibility/status/pricing/
 * limits/feature_flags/support/trial_days/metadata. Nested objects replace
 * the stored object, so send the full `pricing` / `limits` block you want.
 */
router.patch(
  '/plans/:code',
  [codeParam, ...planBodyRules],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const reason = String(req.body.reason || '').trim();
    const update = toPlanUpdate(req.body);

    let plan = await SubscriptionPlan.findOne({ plan_code: code });
    let prevSnapshot = null;
    let revisionNumber = 1;

    if (!plan) {
      const template = findTemplateByCode(code);
      if (!template) return planNotFound(res, 'No template or saved plan with that code.');
      plan = await SubscriptionPlan.create({
        ...templateToDocument(template),
        ...update,
        plan_code: code,
        current_revision: 1,
        updated_by: null
      });
    } else {
      prevSnapshot = serializePlan(plan.toObject());
      revisionNumber = (plan.current_revision || 0) + 1;
      Object.assign(plan, update, { current_revision: revisionNumber, updated_by: null });
      await plan.save();
    }

    const snapshot = serializePlan(plan.toObject());
    const diff = computeDiff(prevSnapshot, snapshot);
    await PlanRevision.create({
      plan_id: plan._id,
      plan_code: plan.plan_code,
      revision_number: revisionNumber,
      snapshot,
      diff,
      reason,
      changed_by: null,
      changed_at: new Date()
    });
    await writeBillingEvent(req, {
      action: prevSnapshot ? 'plan.updated' : 'plan.materialised',
      targetType: 'plan',
      targetId: plan.plan_code,
      targetLabel: plan.plan_name,
      diff,
      reason,
      metadata: { revision: revisionNumber }
    });

    res.json({ success: true, data: { ...snapshot, is_template: false, revisions: await recentRevisions(plan._id) } });
  })
);

/** DELETE /plans/:code — archive (status → archived). Existing subscriptions keep working. */
router.delete(
  '/plans/:code',
  [codeParam],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision, OrganizationSubscription } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const plan = await SubscriptionPlan.findOne({ plan_code: code });
    if (!plan) return planNotFound(res, 'Cannot archive a plan that has never been saved.');

    if (plan.status !== 'archived') {
      const prev = serializePlan(plan.toObject());
      plan.status = 'archived';
      plan.is_active = false;
      plan.current_revision = (plan.current_revision || 0) + 1;
      plan.updated_by = null;
      await plan.save();
      const next = serializePlan(plan.toObject());
      await PlanRevision.create({
        plan_id: plan._id,
        plan_code: plan.plan_code,
        revision_number: plan.current_revision,
        snapshot: next,
        diff: computeDiff(prev, next),
        reason: 'Archived.',
        changed_by: null,
        changed_at: new Date()
      });
      await writeBillingEvent(req, {
        action: 'plan.archived',
        targetType: 'plan',
        targetId: plan.plan_code,
        targetLabel: plan.plan_name,
        reason: 'Archived.'
      });
    }

    const activeSubscriptions = await OrganizationSubscription.countDocuments({ plan_id: plan._id, status: { $ne: 'cancelled' } });
    res.json({ success: true, data: { ...serializePlan(plan.toObject()), is_template: false, active_subscriptions: activeSubscriptions } });
  })
);

/** GET /feature-flags — flag catalogue (DB rows + in-code defaults). */
router.get('/feature-flags', asyncHandler(async (req, res) => {
  const { FeatureFlag } = getRouterModels();
  const dbFlags = await FeatureFlag.find({}).sort({ category: 1, code: 1 }).lean();
  const byCode = new Map(dbFlags.map((f) => [f.code, f]));
  const shape = (f, isTemplate) => ({
    code: f.code, category: f.category, name: f.name, description: f.description || '', status: f.status || 'active', is_template: isTemplate
  });
  const data = DEFAULT_FEATURE_FLAGS.map(([code, category, name]) =>
    byCode.has(code) ? shape(byCode.get(code), false) : shape({ code, category, name }, true)
  );
  for (const f of dbFlags) {
    if (!DEFAULT_FEATURE_FLAGS.some(([code]) => code === f.code)) data.push(shape(f, false));
  }
  res.json({ success: true, data });
}));

export default router;
