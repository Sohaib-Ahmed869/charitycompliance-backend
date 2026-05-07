/**
 * SuperAdmin operational routes — Tenants, Subscriptions, Overrides,
 * Coupons, Audit (BillingEvent stream), Settings.
 *
 * One file because each surface is small. Splits when complexity earns it.
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';

const router = express.Router();

router.use(authenticate);
router.use(requireSuperAdmin);

// ════════════════════════════════════════════════════════════════════
// TENANTS
// ════════════════════════════════════════════════════════════════════

/** GET /admin/tenants — list every registered tenant + their plan + override summary. */
router.get('/tenants', asyncHandler(async (req, res) => {
  const { Tenant, OrganizationSubscription, SubscriptionPlan, SubscriptionOverride } = getRouterModels();
  const tenants = await Tenant.find({}).sort({ createdAt: -1 }).lean();

  const orgIds = tenants.map((t) => t.orgId);
  const subs = await OrganizationSubscription.find({ organization_id: { $in: orgIds } }).lean();
  const overrides = await SubscriptionOverride.find({ tenant_id: { $in: orgIds } }).lean();
  const plans = await SubscriptionPlan.find({}).lean();

  const subByOrg = new Map(subs.map((s) => [s.organization_id, s]));
  const overrideByOrg = new Map(overrides.map((o) => [o.tenant_id, o]));
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  const data = tenants.map((t) => {
    const sub = subByOrg.get(t.orgId);
    const plan = sub ? planById.get(String(sub.plan_id)) : null;
    const override = overrideByOrg.get(t.orgId);
    return {
      orgId: t.orgId,
      dbName: t.dbName,
      status: t.status,
      created_at: t.createdAt,
      subscription: sub
        ? {
            plan_code: plan?.plan_code || 'unknown',
            plan_name: plan?.plan_name || '—',
            billing_cycle: sub.billing_cycle,
            status: sub.status,
            current_period_end: sub.current_period_end
          }
        : null,
      has_override: !!override
    };
  });
  res.json({ success: true, data });
}));

/** GET /admin/tenants/:orgId — tenant detail (subscription + override + recent events). */
router.get(
  '/tenants/:orgId',
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription, SubscriptionPlan, SubscriptionOverride, BillingEvent } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const tenant = await Tenant.findOne({ orgId }).lean();
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId }).lean();
    const plan = sub ? await SubscriptionPlan.findById(sub.plan_id).lean() : null;
    const override = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
    const recentEvents = await BillingEvent.find({ tenant_id: orgId })
      .sort({ created_at: -1 }).limit(20).lean();

    res.json({
      success: true,
      data: {
        orgId: tenant.orgId,
        dbName: tenant.dbName,
        status: tenant.status,
        created_at: tenant.createdAt,
        subscription: sub
          ? {
              _id: sub._id,
              plan_id: sub.plan_id,
              plan_code: plan?.plan_code || null,
              plan_name: plan?.plan_name || null,
              billing_cycle: sub.billing_cycle,
              status: sub.status,
              current_period_start: sub.current_period_start,
              current_period_end: sub.current_period_end,
              cancel_at_period_end: sub.cancel_at_period_end,
              stripe_customer_id: sub.stripe_customer_id || null,
              stripe_subscription_id: sub.stripe_subscription_id || null
            }
          : null,
        override: override
          ? {
              _id: override._id,
              limits: override.limits || {},
              feature_flags: override.feature_flags instanceof Map
                ? Object.fromEntries(override.feature_flags)
                : (override.feature_flags || {}),
              pricing: override.pricing || {},
              effective_from: override.effective_from,
              effective_until: override.effective_until,
              reason: override.reason || ''
            }
          : null,
        recent_events: recentEvents.map(serializeEvent)
      }
    });
  })
);

/** POST /admin/tenants/:orgId/assign-plan — set/change the tenant's plan. */
router.post(
  '/tenants/:orgId/assign-plan',
  [
    param('orgId').isString().trim().notEmpty(),
    body('plan_code').isString().trim().notEmpty(),
    body('billing_cycle').optional().isIn(['monthly', 'yearly'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription, SubscriptionPlan } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const planCode = String(req.body.plan_code).toLowerCase();
    const billingCycle = req.body.billing_cycle || 'monthly';

    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }
    const plan = await SubscriptionPlan.findOne({ plan_code: planCode });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PLAN_NOT_FOUND',
          message: 'Plan must be saved (not just a template) before it can be assigned to a tenant.'
        }
      });
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    const existing = await OrganizationSubscription.findOne({ organization_id: orgId });
    let action = 'subscription.assigned';
    let prev = null;
    if (existing) {
      action = 'subscription.changed';
      prev = { plan_id: existing.plan_id, billing_cycle: existing.billing_cycle, status: existing.status };
      existing.plan_id = plan._id;
      existing.billing_cycle = billingCycle;
      existing.status = 'active';
      existing.current_period_start = now;
      existing.current_period_end = periodEnd;
      await existing.save();
    } else {
      await OrganizationSubscription.create({
        organization_id: orgId,
        plan_id: plan._id,
        billing_cycle: billingCycle,
        status: 'active',
        current_period_start: now,
        current_period_end: periodEnd
      });
    }

    await writeBillingEvent(req, {
      action,
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      diff: prev ? [{ path: 'plan_id', from: String(prev.plan_id), to: String(plan._id) }] : [],
      reason: req.body.reason || `Assigned ${plan.plan_name}.`,
      metadata: { plan_code: plan.plan_code, billing_cycle: billingCycle }
    });

    res.json({ success: true });
  })
);

/** PUT /admin/tenants/:orgId/override — create or replace per-tenant override. */
router.put(
  '/tenants/:orgId/override',
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'A reason is required for any override.' }
      });
    }

    const update = {
      tenant_id: orgId,
      limits: req.body.limits || {},
      feature_flags: req.body.feature_flags || {},
      pricing: req.body.pricing || {},
      effective_from: req.body.effective_from ? new Date(req.body.effective_from) : new Date(),
      effective_until: req.body.effective_until ? new Date(req.body.effective_until) : null,
      reason,
      approved_by: req.user?.userId || null,
      approved_at: new Date()
    };

    const before = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
    const result = await SubscriptionOverride.findOneAndUpdate(
      { tenant_id: orgId },
      { $set: update },
      { upsert: true, new: true }
    );

    await writeBillingEvent(req, {
      action: before ? 'subscription_override.updated' : 'subscription_override.created',
      targetType: 'subscription_override',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason,
      diff: before
        ? [{ path: 'override', from: { limits: before.limits, pricing: before.pricing }, to: { limits: update.limits, pricing: update.pricing } }]
        : [],
      metadata: { effective_until: update.effective_until }
    });

    res.json({ success: true, data: { _id: result._id } });
  })
);

/** DELETE /admin/tenants/:orgId/override — clear the tenant's override. */
router.delete(
  '/tenants/:orgId/override',
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const result = await SubscriptionOverride.findOneAndDelete({ tenant_id: orgId });
    if (result) {
      await writeBillingEvent(req, {
        action: 'subscription_override.cleared',
        targetType: 'subscription_override',
        targetId: orgId,
        targetLabel: orgId,
        tenantId: orgId,
        reason: 'Override cleared.'
      });
    }
    res.json({ success: true });
  })
);

// ════════════════════════════════════════════════════════════════════
// COUPONS
// ════════════════════════════════════════════════════════════════════

router.get('/coupons', asyncHandler(async (req, res) => {
  const { Coupon } = getRouterModels();
  const coupons = await Coupon.find({}).sort({ created_at: -1 }).lean();
  res.json({ success: true, data: coupons.map(serializeCoupon) });
}));

router.post(
  '/coupons',
  [
    body('code').isString().trim().isLength({ min: 2, max: 64 }).matches(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    body('percent_off').optional().isFloat({ min: 0, max: 100 }),
    body('amount_off_aud').optional().isFloat({ min: 0 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Coupon } = getRouterModels();
    const code = String(req.body.code).toUpperCase().trim();
    if (!req.body.percent_off && !req.body.amount_off_aud) {
      return res.status(400).json({
        success: false,
        error: { code: 'DISCOUNT_REQUIRED', message: 'One of percent_off or amount_off_aud is required.' }
      });
    }
    const exists = await Coupon.findOne({ code });
    if (exists) {
      return res.status(409).json({
        success: false,
        error: { code: 'COUPON_CODE_TAKEN', message: 'A coupon with that code already exists.' }
      });
    }
    const created = await Coupon.create({
      code,
      name: req.body.name || '',
      percent_off: req.body.percent_off ?? null,
      amount_off_aud: req.body.amount_off_aud ?? null,
      duration: req.body.duration || 'once',
      duration_in_months: req.body.duration_in_months ?? null,
      max_redemptions: req.body.max_redemptions ?? null,
      redeem_by: req.body.redeem_by ? new Date(req.body.redeem_by) : null,
      applies_to_plan_codes: Array.isArray(req.body.applies_to_plan_codes) ? req.body.applies_to_plan_codes : [],
      created_by: req.user?.userId || null
    });
    await writeBillingEvent(req, {
      action: 'coupon.created',
      targetType: 'coupon',
      targetId: created.code,
      targetLabel: created.name || created.code
    });
    res.status(201).json({ success: true, data: serializeCoupon(created.toObject()) });
  })
);

router.post(
  '/coupons/:code/archive',
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { Coupon } = getRouterModels();
    const code = String(req.params.code).toUpperCase();
    const coupon = await Coupon.findOne({ code });
    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: { code: 'COUPON_NOT_FOUND', message: 'No such coupon.' }
      });
    }
    coupon.status = 'archived';
    await coupon.save();
    await writeBillingEvent(req, {
      action: 'coupon.archived',
      targetType: 'coupon',
      targetId: coupon.code,
      targetLabel: coupon.name || coupon.code
    });
    res.json({ success: true, data: serializeCoupon(coupon.toObject()) });
  })
);

// ════════════════════════════════════════════════════════════════════
// AUDIT (BillingEvent stream)
// ════════════════════════════════════════════════════════════════════

router.get(
  '/audit',
  [
    query('tenantId').optional().isString().trim(),
    query('action').optional().isString().trim(),
    query('limit').optional().isInt({ min: 1, max: 200 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { BillingEvent } = getRouterModels();
    const limit = parseInt(req.query.limit || '100', 10);
    const filter = {};
    if (req.query.tenantId) filter.tenant_id = String(req.query.tenantId).toLowerCase();
    if (req.query.action) filter.action = String(req.query.action);
    const events = await BillingEvent.find(filter).sort({ created_at: -1 }).limit(limit).lean();
    res.json({ success: true, data: events.map(serializeEvent) });
  })
);

// ════════════════════════════════════════════════════════════════════
// SETTINGS — system-level toggles & defaults
// ════════════════════════════════════════════════════════════════════

// Settings live on a single canonical document keyed by `key='global'`.
// Stored on a generic Mongo collection so we don't need a schema for the
// few static fields the spec calls out.
async function getSettingsDoc() {
  const conn = (await import('../../config/database.js')).getRouterConnection();
  return conn.collection('admin_settings');
}

router.get('/settings', asyncHandler(async (req, res) => {
  const col = await getSettingsDoc();
  const doc = await col.findOne({ key: 'global' });
  res.json({
    success: true,
    data: {
      stripeMode: doc?.stripeMode || 'test',
      defaultSoftCapPct: doc?.defaultSoftCapPct ?? 80,
      defaultHardCapPct: doc?.defaultHardCapPct ?? 100,
      defaultTrialDays: doc?.defaultTrialDays ?? 14,
      overagesGloballyDisabled: !!doc?.overagesGloballyDisabled,
      currency: 'AUD'
    }
  });
}));

router.patch(
  '/settings',
  [
    body('stripeMode').optional().isIn(['test', 'live']),
    body('defaultSoftCapPct').optional().isInt({ min: 50, max: 95 }),
    body('defaultHardCapPct').optional().isInt({ min: 80, max: 200 }),
    body('defaultTrialDays').optional().isInt({ min: 0, max: 90 }),
    body('overagesGloballyDisabled').optional().isBoolean()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const col = await getSettingsDoc();
    const update = { updated_at: new Date(), updated_by: req.user?.userId || null };
    for (const k of ['stripeMode', 'defaultSoftCapPct', 'defaultHardCapPct', 'defaultTrialDays', 'overagesGloballyDisabled']) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) update[k] = req.body[k];
    }
    const before = await col.findOne({ key: 'global' });
    await col.updateOne({ key: 'global' }, { $set: { key: 'global', ...update } }, { upsert: true });

    // Special audit: kill-switch toggles get their own action codes.
    if (Object.prototype.hasOwnProperty.call(req.body, 'overagesGloballyDisabled')) {
      const wasOn = !!before?.overagesGloballyDisabled;
      const isOn = !!req.body.overagesGloballyDisabled;
      if (wasOn !== isOn) {
        await writeBillingEvent(req, {
          action: isOn ? 'system.kill_switch_engaged' : 'system.kill_switch_released',
          targetType: 'settings',
          targetId: 'global',
          targetLabel: 'Disable all overages',
          metadata: { from: wasOn, to: isOn }
        });
      }
    }
    res.json({ success: true });
  })
);

// ── helpers ────────────────────────────────────────────────────────

function serializeCoupon(c) {
  return {
    _id: c._id,
    code: c.code,
    name: c.name || '',
    percent_off: c.percent_off ?? null,
    amount_off_aud: c.amount_off_aud ?? null,
    duration: c.duration,
    duration_in_months: c.duration_in_months ?? null,
    max_redemptions: c.max_redemptions ?? null,
    times_redeemed: c.times_redeemed ?? 0,
    redeem_by: c.redeem_by,
    applies_to_plan_codes: c.applies_to_plan_codes || [],
    status: c.status,
    created_at: c.created_at
  };
}

function serializeEvent(e) {
  return {
    _id: e._id,
    action: e.action,
    target_type: e.target_type,
    target_id: e.target_id,
    target_label: e.target_label,
    tenant_id: e.tenant_id || '',
    actor_id: e.actor_id,
    actor_email: e.actor_email,
    diff: e.diff || [],
    reason: e.reason || '',
    metadata: e.metadata || {},
    status: e.status,
    created_at: e.created_at
  };
}

export default router;
