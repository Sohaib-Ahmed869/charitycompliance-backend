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
import { invalidateEntitlements, invalidateAllEntitlements, resolveEntitlements } from '../../services/entitlementService.js';
import { validateOverride } from '../../services/overrideValidationService.js';
import { swapSubscriptionPrice, isStripeConfigured, listInvoicesForCustomer } from '../../services/stripeService.js';
import { sendPlanChangeNotice } from '../../services/billingEmails.js';
import { getOrgOwnerEmail } from '../../utils/getOrgOwnerEmail.js';

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

    // Compute the same entitlements the tenant gets so the SuperAdmin can
    // verify exactly what features / limits are actually being granted.
    const effectiveEntitlements = await resolveEntitlements(orgId).catch(() => null);

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
              stripe_subscription_id: sub.stripe_subscription_id || null,
              is_comp: !!sub.is_comp,
              comp_reason: sub.comp_reason || '',
              comp_granted_at: sub.comp_granted_at || null
            }
          : null,
        override: override
          ? {
              _id: override._id,
              limits: override.limits || {},
              feature_flags: override.feature_flags instanceof Map
                ? Object.fromEntries(override.feature_flags)
                : (override.feature_flags || {}),
              feature_flag_mode: override.feature_flag_mode || 'merge',
              pricing: override.pricing || {},
              effective_from: override.effective_from,
              effective_until: override.effective_until,
              reason: override.reason || ''
            }
          : null,
        recent_events: recentEvents.map(serializeEvent),
        // What the tenant actually sees (post merge of plan + override + kill-switch).
        effective: effectiveEntitlements
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
    const { Tenant, OrganizationSubscription, SubscriptionPlan, PlanRevision } = getRouterModels();
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

    // Pin to the *latest* revision of this plan at assignment time.
    const latestRevision = await PlanRevision
      .findOne({ plan_id: plan._id })
      .sort({ revision_number: -1 })
      .lean();

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    const existing = await OrganizationSubscription.findOne({ organization_id: orgId });
    let action = 'subscription.assigned';
    let prev = null;
    if (existing) {
      action = 'subscription.changed';
      prev = {
        plan_id: existing.plan_id,
        plan_revision_number: existing.plan_revision_number,
        billing_cycle: existing.billing_cycle,
        status: existing.status
      };
      existing.plan_id = plan._id;
      existing.plan_revision_id = latestRevision?._id || null;
      existing.plan_revision_number = latestRevision?.revision_number || null;
      existing.billing_cycle = billingCycle;
      existing.status = 'active';
      existing.current_period_start = now;
      existing.current_period_end = periodEnd;
      await existing.save();
    } else {
      await OrganizationSubscription.create({
        organization_id: orgId,
        plan_id: plan._id,
        plan_revision_id: latestRevision?._id || null,
        plan_revision_number: latestRevision?.revision_number || null,
        billing_cycle: billingCycle,
        status: 'active',
        current_period_start: now,
        current_period_end: periodEnd
      });
    }

    // Bust the entitlement cache so the tenant picks up the new plan.
    invalidateEntitlements(orgId);

    await writeBillingEvent(req, {
      action,
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      diff: prev ? [{ path: 'plan_id', from: String(prev.plan_id), to: String(plan._id) }] : [],
      reason: req.body.reason || `Assigned ${plan.plan_name}.`,
      metadata: {
        plan_code: plan.plan_code,
        billing_cycle: billingCycle,
        revision_number: latestRevision?.revision_number || null
      }
    });

    // Notify org owner about the assignment.
    const ownerEmail = await getOrgOwnerEmail(orgId).catch(() => null);
    if (ownerEmail) {
      sendPlanChangeNotice({
        to: ownerEmail,
        orgName: orgId,
        planName: plan.plan_name,
        billingCycle,
        amountAUD: billingCycle === 'yearly' ? plan.pricing?.annualAUD : plan.pricing?.monthlyAUD,
        reason: req.body.reason || null
      });
    }

    res.json({ success: true });
  })
);

// ════════════════════════════════════════════════════════════════════
// PLAN REVISION MIGRATION (Phase 9 — done early so SuperAdmin has
// a clean way to push a price update to all tenants on a plan).
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/comp — flag this tenant's subscription as
 * comped (free access, no payment required). Reason is mandatory and
 * recorded in BillingEvent.
 *
 * Body: { is_comp: boolean, reason?: string }
 */
router.post(
  '/tenants/:orgId/comp',
  [
    param('orgId').isString().trim().notEmpty(),
    body('is_comp').isBoolean(),
    body('reason').optional().isString()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const isComp = !!req.body.is_comp;
    const reason = String(req.body.reason || '').trim();

    if (isComp && !reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'A reason is required to grant comp access.' }
      });
    }

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub) {
      return res.status(404).json({
        success: false,
        error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Tenant has no subscription to comp. Assign a plan first.' }
      });
    }

    const wasComp = !!sub.is_comp;
    sub.is_comp = isComp;
    sub.comp_reason = isComp ? reason : '';
    sub.comp_granted_by = isComp ? (req.user?.userId || null) : null;
    sub.comp_granted_at = isComp ? new Date() : null;
    if (isComp && sub.status !== 'active') sub.status = 'active';
    await sub.save();

    invalidateEntitlements(orgId);

    await writeBillingEvent(req, {
      action: isComp ? 'subscription_override.created' : 'subscription_override.cleared',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: isComp ? `Comped — ${reason}` : 'Comp removed.',
      diff: [{ path: 'is_comp', from: wasComp, to: isComp }],
      metadata: { kind: 'comp_grant' }
    });

    res.json({ success: true, data: { is_comp: sub.is_comp } });
  })
);

router.post(
  '/plans/:code/migrate-revision',
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision, OrganizationSubscription } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const reason = String(req.body.reason || 'Plan revision migration.').trim();

    const plan = await SubscriptionPlan.findOne({ plan_code: code });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'No such plan.' }
      });
    }
    const latest = await PlanRevision.findOne({ plan_id: plan._id }).sort({ revision_number: -1 }).lean();
    if (!latest) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_REVISIONS', message: 'Plan has no revisions yet.' }
      });
    }

    const stale = await OrganizationSubscription.find({
      plan_id: plan._id,
      $or: [
        { plan_revision_number: { $lt: latest.revision_number } },
        { plan_revision_id: null }
      ]
    });

    // Pick the Stripe Price for the new revision based on each tenant's
    // billing cycle. Snapshot may include the IDs; otherwise read the live plan.
    const monthlyPriceId = latest.snapshot?.pricing?.stripeMonthlyPriceId
      || plan.pricing?.stripeMonthlyPriceId || null;
    const annualPriceId = latest.snapshot?.pricing?.stripeAnnualPriceId
      || plan.pricing?.stripeAnnualPriceId || null;

    let migrated = 0;
    let stripeSynced = 0;
    let stripeFailed = 0;
    const stripeErrors = [];

    for (const sub of stale) {
      const fromRev = sub.plan_revision_number;
      sub.plan_revision_id = latest._id;
      sub.plan_revision_number = latest.revision_number;
      await sub.save();
      invalidateEntitlements(sub.organization_id);

      // Sync to Stripe if the tenant has a real subscription there.
      let stripeStatus = 'skipped'; // 'skipped' | 'synced' | 'failed'
      let stripeError = null;
      if (isStripeConfigured() && sub.stripe_subscription_id) {
        const newPriceId = sub.billing_cycle === 'yearly' ? annualPriceId : monthlyPriceId;
        if (newPriceId) {
          const result = await swapSubscriptionPrice({
            subscriptionId: sub.stripe_subscription_id,
            newPriceId
          });
          if (result.ok) {
            stripeStatus = 'synced';
            stripeSynced += 1;
          } else {
            stripeStatus = 'failed';
            stripeFailed += 1;
            stripeError = result.error;
            stripeErrors.push({ orgId: sub.organization_id, error: result.error });
          }
        } else {
          stripeStatus = 'skipped';
          stripeErrors.push({ orgId: sub.organization_id, error: 'No Stripe price for cycle on the latest revision' });
        }
      }

      await writeBillingEvent(req, {
        action: 'subscription.revision_migrated',
        targetType: 'subscription',
        targetId: sub.organization_id,
        targetLabel: sub.organization_id,
        tenantId: sub.organization_id,
        diff: [{ path: 'plan_revision_number', from: fromRev, to: latest.revision_number }],
        reason,
        metadata: {
          plan_code: plan.plan_code,
          to_revision: latest.revision_number,
          stripe_sync: stripeStatus,
          ...(stripeError ? { stripe_error: stripeError } : {})
        }
      });

      // Notify the org owner about the new pricing/plan version.
      const ownerEmail = await getOrgOwnerEmail(sub.organization_id).catch(() => null);
      if (ownerEmail) {
        const newPricing = latest.snapshot?.pricing || plan.pricing || {};
        sendPlanChangeNotice({
          to: ownerEmail,
          orgName: sub.organization_id,
          planName: plan.plan_name,
          billingCycle: sub.billing_cycle,
          amountAUD: sub.billing_cycle === 'yearly' ? newPricing.annualAUD : newPricing.monthlyAUD,
          reason
        });
      }

      migrated += 1;
    }

    res.json({
      success: true,
      data: {
        migrated,
        latest_revision: latest.revision_number,
        stripe_synced: stripeSynced,
        stripe_failed: stripeFailed,
        stripe_errors: stripeErrors
      }
    });
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

    // Validate against live tenant usage — refuse caps below current usage.
    const validation = await validateOverride(orgId, req.body);
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'OVERRIDE_BELOW_USAGE',
          message: 'One or more limits are below current tenant usage.',
          details: { conflicts: validation.conflicts }
        }
      });
    }

    const update = {
      tenant_id: orgId,
      limits: req.body.limits || {},
      feature_flags: req.body.feature_flags || {},
      feature_flag_mode: req.body.feature_flag_mode === 'replace' ? 'replace' : 'merge',
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

    invalidateEntitlements(orgId);

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

/**
 * POST /admin/tenants/:orgId/override/apply-to-stripe
 *
 * Push the override's tenant-specific Stripe Price IDs onto the tenant's
 * actual Stripe subscription so future invoices bill the override amount,
 * not the plan default. No-op if no override / no Stripe sub / no price IDs.
 */
router.post(
  '/tenants/:orgId/override/apply-to-stripe',
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { OrganizationSubscription, SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' }
      });
    }

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(409).json({
        success: false,
        error: { code: 'NO_STRIPE_SUBSCRIPTION', message: 'Tenant has no Stripe subscription to update.' }
      });
    }
    const override = await SubscriptionOverride.findOne({ tenant_id: orgId });
    if (!override) {
      return res.status(404).json({
        success: false,
        error: { code: 'OVERRIDE_NOT_FOUND', message: 'No override saved for this tenant.' }
      });
    }
    const newPriceId = sub.billing_cycle === 'yearly'
      ? override.pricing?.stripeAnnualPriceId
      : override.pricing?.stripeMonthlyPriceId;
    if (!newPriceId) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'OVERRIDE_PRICE_MISSING',
          message: `Override has no Stripe ${sub.billing_cycle === 'yearly' ? 'annual' : 'monthly'} price configured.`
        }
      });
    }

    const result = await swapSubscriptionPrice({
      subscriptionId: sub.stripe_subscription_id,
      newPriceId
    });
    if (!result.ok) {
      return res.status(502).json({
        success: false,
        error: { code: 'STRIPE_UPDATE_FAILED', message: result.error }
      });
    }

    await writeBillingEvent(req, {
      action: 'subscription_override.updated',
      targetType: 'subscription_override',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: 'Override pricing applied to Stripe subscription.',
      metadata: { stripe_price_id: newPriceId, stripe_subscription_id: sub.stripe_subscription_id }
    });

    res.json({ success: true, data: { stripe_price_id: newPriceId } });
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
      invalidateEntitlements(orgId);
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
// INVOICES (Payment records — populated by Stripe invoice.paid webhook)
// ════════════════════════════════════════════════════════════════════

router.get(
  '/invoices',
  [
    query('tenantId').optional().isString().trim(),
    query('status').optional().isIn(['succeeded', 'failed', 'pending', 'refunded']),
    query('limit').optional().isInt({ min: 1, max: 200 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Payment } = getRouterModels();
    const limit = parseInt(req.query.limit || '100', 10);
    const filter = {};
    if (req.query.tenantId) filter.organization_id = String(req.query.tenantId).toLowerCase();
    if (req.query.status) filter.status = String(req.query.status);
    const payments = await Payment
      .find(filter)
      .sort({ payment_date: -1 })
      .limit(limit)
      .lean();
    res.json({
      success: true,
      data: payments.map((p) => ({
        _id: p._id,
        organization_id: p.organization_id,
        amount: p.amount,
        currency: p.currency || 'AUD',
        status: p.status,
        description: p.description || '',
        invoice_number: p.metadata?.invoice_number || null,
        hosted_invoice_url: p.metadata?.hosted_invoice_url || null,
        invoice_pdf: p.metadata?.invoice_pdf || null,
        stripe_invoice_id: p.stripe_invoice_id || null,
        stripe_payment_intent_id: p.stripe_payment_intent_id || null,
        stripe_subscription_id: p.metadata?.stripe_subscription_id || null,
        payment_date: p.payment_date,
        failure_reason: p.failure_reason || null
      }))
    });
  })
);

/**
 * POST /admin/invoices/backfill
 *
 * Reconcile missing Payment records by pulling every Stripe customer's
 * invoice history and upserting any we haven't already stored. Idempotent
 * via the unique index on `stripe_invoice_id`.
 *
 * Body (optional):
 *   - tenantId — restrict backfill to one tenant
 *   - limit    — max invoices per customer (default 100)
 */
router.post(
  '/invoices/backfill',
  [
    body('tenantId').optional().isString().trim(),
    body('limit').optional().isInt({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' }
      });
    }

    const { OrganizationSubscription, Payment } = getRouterModels();
    const tenantFilter = req.body.tenantId ? { organization_id: String(req.body.tenantId).toLowerCase() } : {};
    const limit = parseInt(req.body.limit || '100', 10);

    // Find tenants with a Stripe customer to backfill against.
    const subs = await OrganizationSubscription
      .find({ ...tenantFilter, stripe_customer_id: { $exists: true, $ne: null, $nin: ['', null] } })
      .lean();

    if (subs.length === 0) {
      return res.json({
        success: true,
        data: { tenants_scanned: 0, inserted: 0, already_present: 0, errors: [] }
      });
    }

    let inserted = 0;
    let alreadyPresent = 0;
    const errors = [];

    for (const sub of subs) {
      try {
        const invoices = await listInvoicesForCustomer({ customerId: sub.stripe_customer_id, limit });
        for (const inv of invoices) {
          // Skip drafts and uncollected invoices — only persist things that
          // represent actual money state changes.
          if (!['paid', 'uncollectible', 'void', 'open'].includes(inv.status)) continue;

          // Map Stripe invoice status → local Payment status.
          let localStatus = 'pending';
          if (inv.status === 'paid')          localStatus = 'succeeded';
          else if (inv.status === 'uncollectible') localStatus = 'failed';
          else if (inv.status === 'void')     localStatus = 'failed';

          try {
            const created = await Payment.create({
              organization_id: sub.organization_id,
              stripe_payment_id: inv.payment_intent || inv.id,
              stripe_payment_intent_id: inv.payment_intent || null,
              stripe_invoice_id: inv.id,
              amount: (inv.amount_paid || inv.amount_due || 0) / 100,
              currency: (inv.currency || 'aud').toUpperCase(),
              status: localStatus,
              description: inv.description || `Stripe invoice ${inv.number || inv.id}`,
              metadata: {
                hosted_invoice_url: inv.hosted_invoice_url,
                invoice_pdf: inv.invoice_pdf,
                invoice_number: inv.number,
                stripe_subscription_id: inv.subscription,
                backfilled: true
              },
              payment_date: inv.status_transitions?.paid_at
                ? new Date(inv.status_transitions.paid_at * 1000)
                : new Date(inv.created * 1000)
            });
            if (created) inserted += 1;
          } catch (err) {
            if (err?.code === 11000) {
              alreadyPresent += 1; // unique index hit — already stored
            } else {
              errors.push({ orgId: sub.organization_id, invoiceId: inv.id, error: err?.message || String(err) });
            }
          }
        }
      } catch (err) {
        errors.push({ orgId: sub.organization_id, error: err?.message || String(err) });
      }
    }

    await writeBillingEvent(req, {
      action: 'plan.updated', // generic catch-all; invoice backfill doesn't have a dedicated action
      targetType: 'invoices',
      targetId: 'backfill',
      targetLabel: req.body.tenantId || 'all-tenants',
      reason: `Invoice backfill: ${inserted} inserted, ${alreadyPresent} already present, ${errors.length} errors.`,
      metadata: { kind: 'invoice_backfill', inserted, already_present: alreadyPresent, errors_count: errors.length }
    });

    res.json({
      success: true,
      data: {
        tenants_scanned: subs.length,
        inserted,
        already_present: alreadyPresent,
        errors
      }
    });
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

    // Bust every tenant's entitlement cache — settings changes are global.
    invalidateAllEntitlements();

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
