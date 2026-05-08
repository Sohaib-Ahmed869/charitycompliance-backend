/**
 * Tenant-facing billing endpoints — what the org owner sees on /billing.
 *
 * Mounted under /api/v1/platform/billing with `authAndResolveTenant` so
 * orgId comes from the JWT and tenant DB lookups go to the right place.
 *
 * Three reads:
 *   GET  /me               — entitlements (resolver output) for this org
 *   GET  /usage            — current period usage counters (workflows/seats/etc.)
 *   GET  /available-plans  — public plans the tenant could upgrade/downgrade to
 *   GET  /events           — last 20 BillingEvents scoped to this tenant
 */

import express from 'express';
import { body } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { resolveEntitlements } from '../../services/entitlementService.js';
import { getUsageSummary } from '../../services/usageMeterService.js';
import { mergePlansWithTemplates, DEFAULT_FEATURE_FLAGS } from '../../utils/defaultPlans.js';
import {
  isStripeConfigured,
  ensureStripeCustomer,
  createCheckoutSession,
  createPortalSession
} from '../../services/stripeService.js';
import { server as serverConfig } from '../../config/index.js';

const router = express.Router();

router.use(authAndResolveTenant);

/** GET /platform/billing/me — current plan, limits, feature flags. */
router.get('/me', asyncHandler(async (req, res) => {
  const data = await resolveEntitlements(req.orgId);
  res.json({ success: true, data });
}));

/** GET /platform/billing/usage — per-metric usage with reset cadence + thresholds. */
router.get('/usage', asyncHandler(async (req, res) => {
  const entitlements = await resolveEntitlements(req.orgId);
  const usage = await getUsageSummary({ tenantDb: req.tenantDb, orgId: req.orgId });
  const limits = entitlements.limits || {};
  const softCap = (limits.softCapPct ?? 80) / 100;
  const hardCap = (limits.hardCapPct ?? 100) / 100;

  // End of today (UTC) for daily-reset metrics.
  const dailyResetAt = new Date();
  dailyResetAt.setUTCHours(24, 0, 0, 0);

  const items = [
    buildItem({
      key: 'workflowsPerMonth',
      label: 'Workflows',
      caption: 'Approval workflows started this billing period',
      kind: 'metered',
      used: usage.workflowsThisPeriod,
      limit: limits.workflowsPerMonth,
      resetAt: usage.period_end,
      resetCadence: 'period',
      softCap, hardCap
    }),
    buildItem({
      key: 'apiCallsPerDay',
      label: 'API calls',
      caption: 'Authenticated API requests today',
      kind: 'metered',
      used: usage.apiCallsToday ?? 0,
      limit: limits.apiCallsPerDay,
      resetAt: dailyResetAt,
      resetCadence: 'daily',
      softCap, hardCap
    }),
    buildItem({
      key: 'staffSeats',
      label: 'Staff seats',
      caption: 'Active staff users in this organisation',
      kind: 'allocation',
      used: usage.staffSeatsActive,
      limit: limits.staffSeats,
      softCap, hardCap
    }),
    buildItem({
      key: 'boardSeats',
      label: 'Board seats',
      caption: 'Active responsible-people / board members',
      kind: 'allocation',
      used: usage.boardSeatsActive,
      limit: limits.boardSeats,
      softCap, hardCap
    }),
    buildItem({
      key: 'storageGB',
      label: 'Storage',
      caption: 'Documents and attachments',
      kind: 'allocation',
      used: usage.storageGBUsed,
      limit: limits.storageGB,
      unitSuffix: 'GB',
      softCap, hardCap
    })
  ];

  res.json({
    success: true,
    data: {
      period_start: usage.period_start,
      period_end: usage.period_end,
      items,
      soft_cap_pct: limits.softCapPct ?? 80,
      hard_cap_pct: limits.hardCapPct ?? 100
    }
  });
}));

/**
 * GET /platform/billing/available-plans — public plans + the tenant's
 * currently-assigned plan (even if private/custom).
 *
 * Why include the assigned-but-private plan: SuperAdmin may have built
 * an "Acme Custom" plan only for that tenant. The tenant still needs
 * to be able to see and pay for it on the paywall.
 */
router.get('/available-plans', asyncHandler(async (req, res) => {
  const { SubscriptionPlan, OrganizationSubscription } = getRouterModels();

  const dbPlans = await SubscriptionPlan
    .find({ visibility: 'public', status: 'active' })
    .sort({ 'metadata.sortOrder': 1, plan_code: 1 })
    .lean();

  // Tenant's current plan — pull it in even if non-public.
  const sub = await OrganizationSubscription.findOne({ organization_id: req.orgId }).lean();
  let myPlan = null;
  if (sub?.plan_id) {
    const found = await SubscriptionPlan.findById(sub.plan_id).lean();
    if (found) myPlan = found;
  }

  const all = [...dbPlans];
  if (myPlan && !all.some((p) => String(p._id) === String(myPlan._id))) {
    // Prepend the tenant's plan so it surfaces first ("Your plan").
    all.unshift(myPlan);
  }

  const merged = mergePlansWithTemplates(all.map((p) => ({
    _id: p._id,
    code: p.plan_code,
    name: p.plan_name,
    visibility: p.visibility || 'public',
    status: p.status || 'active',
    pricing: p.pricing || {},
    limits: p.limits || {},
    feature_flags: p.feature_flags instanceof Map ? Object.fromEntries(p.feature_flags) : (p.feature_flags || {}),
    support: p.support || {},
    trial_days: p.trial_days ?? 14,
    metadata: p.metadata || {},
    current_revision: p.current_revision ?? 1
  })));
  const myPlanCode = myPlan?.plan_code;
  // Show the tenant's current plan + any public plan that isn't archived.
  const visible = merged.filter((p) =>
    p.status !== 'archived' &&
    (p.visibility === 'public' || p.code === myPlanCode)
  );
  res.json({ success: true, data: visible });
}));

/**
 * GET /platform/billing/feature-catalog — public catalogue of every
 * feature flag (code + friendly name + category). Used by the
 * FeatureLockedModal to render a human-readable feature name when a
 * tenant tries to use something not on their plan.
 */
router.get('/feature-catalog', asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: DEFAULT_FEATURE_FLAGS.map(([code, category, name, , description]) => ({
      code, category, name, description: description || ''
    }))
  });
}));

/** GET /platform/billing/events — recent BillingEvents for this tenant. */
router.get('/events', asyncHandler(async (req, res) => {
  const { BillingEvent } = getRouterModels();
  const events = await BillingEvent
    .find({ tenant_id: req.orgId })
    .sort({ created_at: -1 })
    .limit(20)
    .lean();
  res.json({
    success: true,
    data: events.map((e) => ({
      _id: e._id,
      action: e.action,
      target_type: e.target_type,
      target_label: e.target_label,
      reason: e.reason || '',
      created_at: e.created_at
    }))
  });
}));

// ── Stripe Checkout — tenant-initiated subscription start/switch ────

/**
 * POST /platform/billing/checkout
 * Body: { plan_code, billing_cycle ('monthly'|'yearly'), coupon_code? }
 * Returns { url } — redirect the browser there for Stripe-hosted checkout.
 */
router.post(
  '/checkout',
  [
    body('plan_code').isString().trim().notEmpty(),
    body('billing_cycle').optional().isIn(['monthly', 'yearly'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured. Contact billing@calcite.tech.' }
      });
    }

    const { SubscriptionPlan, OrganizationSubscription, Tenant } = getRouterModels();
    const planCode = String(req.body.plan_code).toLowerCase();
    const billingCycle = req.body.billing_cycle || 'monthly';
    const couponCode = req.body.coupon_code ? String(req.body.coupon_code).toUpperCase() : null;

    const plan = await SubscriptionPlan.findOne({ plan_code: planCode, status: 'active', visibility: 'public' });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'Plan not available for self-checkout.' }
      });
    }

    const priceId = billingCycle === 'yearly' ? plan.pricing?.stripeAnnualPriceId : plan.pricing?.stripeMonthlyPriceId;
    if (!priceId) {
      return res.status(409).json({
        success: false,
        error: { code: 'STRIPE_PRICE_MISSING', message: 'This plan has no Stripe price for that cycle. Contact support.' }
      });
    }
    // (existingSub is fetched below — reused for both customer lookup and setup-fee gate.)

    // Ensure customer + reuse the existing one if the tenant has subscribed before.
    const existingSub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
    let customerId = existingSub?.stripe_customer_id;
    if (!customerId) {
      const tenant = await Tenant.findOne({ orgId: req.orgId }).lean();
      const customer = await ensureStripeCustomer({
        orgId: req.orgId,
        email: req.user?.email,
        name: tenant?.orgId || req.orgId
      });
      customerId = customer.id;
    }

    // Setup fee — only on a tenant's FIRST Stripe subscription. Plan change
    // ladder (e.g. Foundation → Professional) doesn't re-charge the fee.
    const isNewSubscription = !existingSub?.stripe_subscription_id;
    const setupFeePriceId = isNewSubscription
      ? (billingCycle === 'yearly'
          ? plan.pricing?.stripeSetupAnnualPriceId
          : plan.pricing?.stripeSetupMonthlyPriceId)
      : null;

    const frontendBase = (serverConfig.corsOrigin?.[0] || 'http://localhost:5173').replace(/\/$/, '');
    const session = await createCheckoutSession({
      customerId,
      priceId,
      orgId: req.orgId,
      planCode: plan.plan_code,
      billingCycle,
      successUrl: `${frontendBase}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${frontendBase}/billing?checkout=cancelled`,
      trialDays: plan.trial_days || 0,
      couponCode,
      setupFeePriceId
    });

    res.json({ success: true, data: { url: session.url } });
  })
);

/**
 * POST /platform/billing/portal
 * Returns { url } pointing at Stripe Customer Portal — tenant manages
 * card/cancel/invoices there.
 */
router.post('/portal', asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({
      success: false,
      error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured. Contact billing@calcite.tech.' }
    });
  }
  const { OrganizationSubscription } = getRouterModels();
  const sub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
  if (!sub?.stripe_customer_id) {
    return res.status(409).json({
      success: false,
      error: { code: 'NO_STRIPE_CUSTOMER', message: 'No Stripe customer on file. Start a checkout first.' }
    });
  }
  const frontendBase = (serverConfig.corsOrigin?.[0] || 'http://localhost:5173').replace(/\/$/, '');
  const session = await createPortalSession({
    customerId: sub.stripe_customer_id,
    returnUrl: `${frontendBase}/billing`
  });
  res.json({ success: true, data: { url: session.url } });
}));

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Build one usage card payload.
 *
 *   status: 'healthy' | 'approaching' | 'near_limit' | 'at_limit' | 'unlimited' | 'not_tracked'
 *   kind:   'metered' (resets) | 'allocation' (active count, no reset)
 */
function buildItem({
  key, label, caption, kind = 'metered',
  used, limit, resetAt, resetCadence,
  unitSuffix, softCap = 0.8, hardCap = 1.0, tracking = true
}) {
  const usedNum = Number(used || 0);
  const lim = limit == null ? 0 : Number(limit);
  const unlimited = lim === -1;
  const noLimit = lim === 0;
  const ratio = unlimited || lim <= 0 ? 0 : usedNum / lim;
  let status = 'healthy';
  if (!tracking) status = 'not_tracked';
  else if (unlimited) status = 'unlimited';
  else if (noLimit) status = 'not_included';
  else if (ratio >= hardCap) status = 'at_limit';
  else if (ratio >= softCap) status = 'near_limit';
  else if (ratio >= softCap * 0.6) status = 'approaching';
  return {
    key,
    label,
    caption,
    kind,
    used: usedNum,
    limit: lim,
    unit_suffix: unitSuffix || null,
    unlimited,
    no_limit: noLimit,
    ratio: Math.min(1.5, ratio),
    pct: Math.round(ratio * 100),
    status,
    tracking,
    reset_at: resetAt || null,
    reset_cadence: resetCadence || null
  };
}

export default router;
