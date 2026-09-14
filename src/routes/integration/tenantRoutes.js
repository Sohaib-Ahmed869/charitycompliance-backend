/**
 * Integration API — Tenants (CRUD + subscription/plan assignment).
 *
 * Mounted under /api/v1/integration behind requireApiKey. Mirrors the
 * SuperAdmin tenant surface (routes/admin/opsRoutes.js) and adds the
 * lifecycle the admin portal doesn't have: create, update, delete.
 *
 * Delete is a soft delete (status → 'deleted'): the tenant DB and its data
 * are kept, logins and tenant-scoped API calls stop working immediately,
 * and PATCH { status: 'active' } brings it back.
 */

import express from 'express';
import crypto from 'crypto';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { clearTenantCache } from '../../db/router.js';
import { getTenantConnection } from '../../db/connectionManager.js';
import { OrganizationRepository } from '../../repositories/organizationRepository.js';
import authService from '../../services/authService.js';
import { password as passwordPolicy } from '../../config/index.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
import { serializeEvent } from '../admin/opsRoutes.js';

const router = express.Router();

const TENANT_STATUSES = ['active', 'suspended', 'deleted'];
const orgIdParam = param('orgId').isString().trim().notEmpty();

const notFound = (res) => res.status(404).json({
  success: false,
  error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
});

/** A password that satisfies the platform policy (upper, lower, digit, symbol). */
function generateOwnerPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '@#%^_+-=!'];
  const all = sets.join('');
  const length = Math.max(20, passwordPolicy.minLength);
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function loadOrgName(tenant) {
  if (tenant.status !== 'active') return null;
  try {
    const org = await new OrganizationRepository(await getTenantConnection(tenant.orgId)).findOne();
    return org?.name || null;
  } catch {
    return null;
  }
}

function serializeSubscription(sub, plan) {
  if (!sub) return null;
  return {
    _id: sub._id,
    plan_id: sub.plan_id,
    plan_code: plan?.plan_code || null,
    plan_name: plan?.plan_name || null,
    billing_cycle: sub.billing_cycle,
    status: sub.status,
    current_period_start: sub.current_period_start,
    current_period_end: sub.current_period_end,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancelled_at: sub.cancelled_at || null
  };
}

function serializeOverride(override) {
  if (!override) return null;
  return {
    _id: override._id,
    limits: override.limits || {},
    feature_flags: override.feature_flags instanceof Map
      ? Object.fromEntries(override.feature_flags)
      : (override.feature_flags || {}),
    pricing: override.pricing || {},
    effective_from: override.effective_from,
    effective_until: override.effective_until,
    reason: override.reason || ''
  };
}

async function tenantDetail(orgId) {
  const { Tenant, OrganizationSubscription, SubscriptionPlan, SubscriptionOverride, BillingEvent } = getRouterModels();
  const tenant = await Tenant.findOne({ orgId }).lean();
  if (!tenant) return null;
  const sub = await OrganizationSubscription.findOne({ organization_id: orgId }).lean();
  const plan = sub ? await SubscriptionPlan.findById(sub.plan_id).lean() : null;
  const override = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
  const recentEvents = await BillingEvent.find({ tenant_id: orgId }).sort({ created_at: -1 }).limit(20).lean();
  return {
    orgId: tenant.orgId,
    name: await loadOrgName(tenant),
    dbName: tenant.dbName,
    status: tenant.status,
    created_at: tenant.createdAt,
    updated_at: tenant.updatedAt,
    subscription: serializeSubscription(sub, plan),
    override: serializeOverride(override),
    recent_events: recentEvents.map(serializeEvent)
  };
}

// ── Read ──────────────────────────────────────────────────────────────

/** GET /tenants?status=active — every tenant with plan + override summary. */
router.get(
  '/tenants',
  [query('status').optional().isIn(TENANT_STATUSES)],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription, SubscriptionPlan, SubscriptionOverride } = getRouterModels();
    const filter = req.query.status ? { status: req.query.status } : {};
    const tenants = await Tenant.find(filter).sort({ createdAt: -1 }).lean();

    const orgIds = tenants.map((t) => t.orgId);
    const [subs, overrides, plans] = await Promise.all([
      OrganizationSubscription.find({ organization_id: { $in: orgIds } }).lean(),
      SubscriptionOverride.find({ tenant_id: { $in: orgIds } }).lean(),
      SubscriptionPlan.find({}).lean()
    ]);
    const subByOrg = new Map(subs.map((s) => [s.organization_id, s]));
    const overrideOrgs = new Set(overrides.map((o) => o.tenant_id));
    const planById = new Map(plans.map((p) => [String(p._id), p]));

    const data = await Promise.all(tenants.map(async (t) => {
      const sub = subByOrg.get(t.orgId);
      return {
        orgId: t.orgId,
        name: await loadOrgName(t),
        dbName: t.dbName,
        status: t.status,
        created_at: t.createdAt,
        subscription: serializeSubscription(sub, sub ? planById.get(String(sub.plan_id)) : null),
        has_override: overrideOrgs.has(t.orgId)
      };
    }));
    res.json({ success: true, data });
  })
);

/** GET /tenants/:orgId — tenant detail (subscription + override + recent events). */
router.get(
  '/tenants/:orgId',
  [orgIdParam],
  validate,
  asyncHandler(async (req, res) => {
    const detail = await tenantDetail(String(req.params.orgId).toLowerCase());
    if (!detail) return notFound(res);
    res.json({ success: true, data: detail });
  })
);

// ── Create ────────────────────────────────────────────────────────────

/**
 * POST /tenants — provision a new organisation + its owner account.
 * Runs the same path as self-service signup (tenant DB, org doc, owner
 * user with admin role). `password` is optional; when omitted a policy-
 * compliant one is generated and returned ONCE in the response.
 */
router.post(
  '/tenants',
  [
    body('organizationName').isString().trim().isLength({ min: 2, max: 80 })
      .withMessage('organizationName must be 2–80 characters'),
    body('email').isEmail().withMessage('Valid owner email required').normalizeEmail(),
    body('firstName').isString().trim().isLength({ min: 1, max: 50 }).withMessage('firstName is required'),
    body('lastName').isString().trim().isLength({ min: 1, max: 50 }).withMessage('lastName is required'),
    body('password').optional().isString()
      .isLength({ min: passwordPolicy.minLength })
      .matches(/[A-Z]/).matches(/[a-z]/).matches(/[0-9]/).matches(/[^A-Za-z0-9]/)
      .withMessage('password must include upper, lower, number and special character')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { organizationName, email, firstName, lastName } = req.body;
    const generated = !req.body.password;
    const password = req.body.password || generateOwnerPassword();

    const result = await authService.register({ email, password, organizationName, firstName, lastName });

    await writeBillingEvent(req, {
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: result.orgId,
      targetLabel: organizationName,
      tenantId: result.orgId,
      reason: 'Provisioned via integration API.',
      metadata: { owner_email: email }
    });

    res.status(201).json({
      success: true,
      data: {
        orgId: result.orgId,
        name: organizationName,
        status: 'active',
        owner: result.user,
        // Only present when generated here — not stored or logged anywhere.
        ...(generated ? { ownerPassword: password } : {})
      }
    });
  })
);

// ── Update ────────────────────────────────────────────────────────────

/** PATCH /tenants/:orgId — { status?, name? }. status: active | suspended | deleted. */
router.patch(
  '/tenants/:orgId',
  [
    orgIdParam,
    body('status').optional().isIn(TENANT_STATUSES),
    body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
    body('reason').optional().isString()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) return notFound(res);

    const { status, name } = req.body;
    if (status == null && name == null) {
      return res.status(400).json({
        success: false,
        error: { code: 'NOTHING_TO_UPDATE', message: 'Provide status and/or name.' }
      });
    }

    const reason = String(req.body.reason || '').trim();
    if (status && status !== tenant.status) {
      await setTenantStatus(req, tenant, status, reason);
    }

    if (name != null) {
      if (tenant.status !== 'active') {
        return res.status(409).json({
          success: false,
          error: { code: 'TENANT_INACTIVE', message: 'Reactivate the tenant before renaming it.' }
        });
      }
      const orgRepo = new OrganizationRepository(await getTenantConnection(orgId));
      const before = await orgRepo.findOne();
      await orgRepo.update({ name });
      await writeBillingEvent(req, {
        action: 'tenant.updated',
        targetType: 'tenant',
        targetId: orgId,
        targetLabel: name,
        tenantId: orgId,
        diff: [{ path: 'name', from: before?.name ?? null, to: name }],
        reason
      });
    }

    res.json({ success: true, data: await tenantDetail(orgId) });
  })
);

// ── Delete ────────────────────────────────────────────────────────────

/** DELETE /tenants/:orgId — soft delete (status → deleted, subscription cancelled). */
router.delete(
  '/tenants/:orgId',
  [orgIdParam],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) return notFound(res);
    if (tenant.status !== 'deleted') {
      await setTenantStatus(req, tenant, 'deleted', String(req.body?.reason || '').trim());
    }
    res.json({ success: true, data: { orgId, status: 'deleted' } });
  })
);

async function setTenantStatus(req, tenant, status, reason) {
  const { OrganizationSubscription } = getRouterModels();
  const from = tenant.status;
  tenant.status = status;
  tenant.updatedAt = new Date();
  await tenant.save();
  // lookupTenant caches active tenants for up to an hour — drop the entry so
  // suspension/deletion takes effect on the very next request.
  clearTenantCache(tenant.orgId);

  if (status === 'deleted') {
    await OrganizationSubscription.updateOne(
      { organization_id: tenant.orgId, status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled', cancelled_at: new Date() } }
    );
  }

  const action = status === 'active' ? 'tenant.reactivated' : status === 'suspended' ? 'tenant.suspended' : 'tenant.deleted';
  await writeBillingEvent(req, {
    action,
    targetType: 'tenant',
    targetId: tenant.orgId,
    targetLabel: tenant.orgId,
    tenantId: tenant.orgId,
    diff: [{ path: 'status', from, to: status }],
    reason
  });
}

// ── Plan assignment & overrides ───────────────────────────────────────

/** POST /tenants/:orgId/assign-plan — { plan_code, billing_cycle?, reason? }. */
router.post(
  '/tenants/:orgId/assign-plan',
  [
    orgIdParam,
    body('plan_code').isString().trim().notEmpty(),
    body('billing_cycle').optional().isIn(['monthly', 'yearly']),
    body('reason').optional().isString()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription, SubscriptionPlan } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const planCode = String(req.body.plan_code).toLowerCase();
    const billingCycle = req.body.billing_cycle || 'monthly';

    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) return notFound(res);
    const plan = await SubscriptionPlan.findOne({ plan_code: planCode });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PLAN_NOT_FOUND',
          message: 'Plan must be saved (not just a template) before it can be assigned — PATCH /plans/:code once to materialise it.'
        }
      });
    }
    if (plan.status === 'archived') {
      return res.status(409).json({
        success: false,
        error: { code: 'PLAN_ARCHIVED', message: 'Archived plans cannot be assigned.' }
      });
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    const existing = await OrganizationSubscription.findOne({ organization_id: orgId });
    let prev = null;
    if (existing) {
      prev = { plan_id: existing.plan_id, billing_cycle: existing.billing_cycle };
      Object.assign(existing, {
        plan_id: plan._id,
        billing_cycle: billingCycle,
        status: 'active',
        current_period_start: now,
        current_period_end: periodEnd,
        cancelled_at: null
      });
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
      action: prev ? 'subscription.changed' : 'subscription.assigned',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      diff: prev
        ? [
            { path: 'plan_id', from: String(prev.plan_id), to: String(plan._id) },
            ...(prev.billing_cycle !== billingCycle ? [{ path: 'billing_cycle', from: prev.billing_cycle, to: billingCycle }] : [])
          ]
        : [],
      reason: req.body.reason || `Assigned ${plan.plan_name}.`,
      metadata: { plan_code: plan.plan_code, billing_cycle: billingCycle }
    });

    res.json({ success: true, data: await tenantDetail(orgId) });
  })
);

/** PUT /tenants/:orgId/override — create/replace per-tenant limits/flags/pricing. `reason` required. */
router.put(
  '/tenants/:orgId/override',
  [
    orgIdParam,
    body('reason').isString().trim().notEmpty().withMessage('A reason is required for any override.'),
    body('limits').optional().isObject(),
    body('feature_flags').optional().isObject(),
    body('pricing').optional().isObject(),
    body('effective_from').optional({ values: 'null' }).isISO8601(),
    body('effective_until').optional({ values: 'null' }).isISO8601()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    if (!(await Tenant.exists({ orgId }))) return notFound(res);

    const reason = String(req.body.reason).trim();
    const update = {
      tenant_id: orgId,
      limits: req.body.limits || {},
      feature_flags: req.body.feature_flags || {},
      pricing: req.body.pricing || {},
      effective_from: req.body.effective_from ? new Date(req.body.effective_from) : new Date(),
      effective_until: req.body.effective_until ? new Date(req.body.effective_until) : null,
      reason,
      approved_by: null,
      approved_at: new Date()
    };

    const before = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
    const result = await SubscriptionOverride.findOneAndUpdate(
      { tenant_id: orgId },
      { $set: update },
      { upsert: true, new: true }
    ).lean();

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

    res.json({ success: true, data: serializeOverride(result) });
  })
);

/** DELETE /tenants/:orgId/override — clear the tenant's override. */
router.delete(
  '/tenants/:orgId/override',
  [orgIdParam],
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
    res.json({ success: true, data: { cleared: !!result } });
  })
);

export default router;
