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
  createPortalSession,
  ensureStripeCouponForLocal,
  retrievePrice,
  retrieveSubscription
} from '../../services/stripeService.js';
import { server as serverConfig } from '../../config/index.js';

const router = express.Router();

router.use(authAndResolveTenant);

/** GET /platform/billing/me — current plan, limits, feature flags. */
router.get('/me', asyncHandler(async (req, res) => {
  const data = await resolveEntitlements(req.orgId);
  res.json({ success: true, data });
}));

/**
 * GET /platform/billing/support-visits
 * Returns every Calcite support session that touched this tenant.
 * Lets the tenant see "Calcite support visited at X for reason Y" in
 * their own audit trail (handbook §3.6 — audit-first).
 */
router.get('/support-visits', asyncHandler(async (req, res) => {
  const { BillingEvent } = getRouterModels();
  const events = await BillingEvent
    .find({
      tenant_id: req.orgId,
      action: { $in: ['support.session_started', 'support.session_ended'] }
    })
    .sort({ created_at: -1 })
    .limit(100)
    .lean();
  res.json({
    success: true,
    data: events.map((e) => ({
      _id: e._id,
      action: e.action,
      agent_email: e.actor_email || e.metadata?.agent_email || '—',
      reason: e.reason || '',
      session_id: e.metadata?.session_id || null,
      ttl_seconds: e.metadata?.ttl_seconds || null,
      created_at: e.created_at
    }))
  });
}));

/**
 * PUT /platform/billing/hard-cap
 * Body: { hard_cap_aud (number | null) }
 * Tenant self-serves a "never bill me more than $X in overages" cap.
 * Set `null` (or 0) to remove the cap.
 */
router.put('/hard-cap', [body('hard_cap_aud').optional().custom((v) => v === null || (typeof v === 'number' && v >= 0))], validate, asyncHandler(async (req, res) => {
  const { OrganizationSubscription } = getRouterModels();
  const sub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
  if (!sub) {
    return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No subscription on file.' } });
  }
  const incoming = req.body.hard_cap_aud;
  sub.hard_cap_aud = incoming == null || incoming === 0 ? null : Number(incoming);
  await sub.save();

  const { BillingEvent } = getRouterModels();
  await BillingEvent.create({
    action: 'subscription.hard_cap_set',
    target_type: 'subscription',
    target_id: req.orgId,
    target_label: req.orgId,
    tenant_id: req.orgId,
    actor_id: req.user?.userId || null,
    actor_email: req.user?.email || '',
    metadata: { hard_cap_aud: sub.hard_cap_aud }
  }).catch(() => {});

  // Bust the entitlement cache so /me reflects the new cap immediately.
  const { invalidateEntitlements } = await import('../../services/entitlementService.js');
  invalidateEntitlements(req.orgId);

  res.json({ success: true, data: { hard_cap_aud: sub.hard_cap_aud } });
}));

/**
 * GET /platform/billing/active-discount
 *
 * Looks up the tenant's active Stripe subscription and returns its
 * currently-attached discount (if any). The /me + entitlement resolver
 * is Mongo-only by design (5 ms p95); this endpoint adds an explicit
 * Stripe round-trip only when the BillingPage actually needs the
 * post-discount amount.
 *
 * Returns one of:
 *   { active: false }
 *   { active: true, coupon: { id, name, percent_off, amount_off, currency }, discount_amount, applied_until }
 */
router.get('/active-discount', asyncHandler(async (req, res) => {
  const { OrganizationSubscription } = getRouterModels();
  const sub = await OrganizationSubscription.findOne({ organization_id: req.orgId }).lean();
  if (!sub?.stripe_subscription_id || !isStripeConfigured()) {
    return res.json({ success: true, data: { active: false } });
  }
  try {
    const sresult = await retrieveSubscription(sub.stripe_subscription_id);
    if (!sresult?.discount) {
      return res.json({ success: true, data: { active: false } });
    }
    // Stripe shape: subscription.discount = { coupon: {...}, end?, start, promotion_code? }
    const d = sresult.discount;
    const c = d.coupon || {};
    res.json({
      success: true,
      data: {
        active: true,
        coupon: {
          id: c.id || null,
          name: c.name || c.id || null,
          percent_off: c.percent_off ?? null,
          amount_off: c.amount_off != null ? c.amount_off / 100 : null,
          currency: c.currency || null,
          duration: c.duration || null,
          duration_in_months: c.duration_in_months || null
        },
        // When the discount stops applying (for `repeating` coupons).
        applied_until: d.end ? new Date(d.end * 1000) : null,
        promotion_code: d.promotion_code || null
      }
    });
  } catch (err) {
    // Don't fail the request — billing page can render the catalogue
    // price as fallback if Stripe hiccups.
    console.error('[active-discount] Stripe lookup failed:', err?.message || err);
    res.json({ success: true, data: { active: false, error: err?.message || 'Stripe lookup failed' } });
  }
}));

/**
 * GET /platform/billing/coupon/:code — validate a coupon code and
 * return the discount shape so the paywall page can show a strikethrough
 * price preview before the tenant goes to Stripe checkout.
 *
 * Returns 404 if the code is unknown / archived / expired / out of
 * redemptions, with a friendly message the UI can surface verbatim.
 */
router.get('/coupon/:code', asyncHandler(async (req, res) => {
  const { Coupon } = getRouterModels();
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ success: false, error: { code: 'COUPON_CODE_REQUIRED', message: 'Coupon code missing.' } });
  }
  const coupon = await Coupon.findOne({ code }).lean();
  if (!coupon) {
    return res.status(404).json({ success: false, error: { code: 'COUPON_UNKNOWN', message: 'No coupon with that code.' } });
  }
  if (coupon.status === 'archived') {
    return res.status(404).json({ success: false, error: { code: 'COUPON_ARCHIVED', message: 'This coupon is no longer available.' } });
  }
  if (coupon.redeem_by && new Date(coupon.redeem_by).getTime() < Date.now()) {
    return res.status(404).json({ success: false, error: { code: 'COUPON_EXPIRED', message: 'This coupon has expired.' } });
  }
  if (coupon.max_redemptions && coupon.times_redeemed >= coupon.max_redemptions) {
    return res.status(404).json({ success: false, error: { code: 'COUPON_FULLY_REDEEMED', message: 'This coupon has reached its redemption limit.' } });
  }
  res.json({
    success: true,
    data: {
      code: coupon.code,
      name: coupon.name || '',
      percent_off: coupon.percent_off ?? null,
      amount_off_aud: coupon.amount_off_aud ?? null,
      duration: coupon.duration || 'once',
      duration_in_months: coupon.duration_in_months || null,
      // Plan whitelist — empty means "applies to any plan".
      applies_to_plan_codes: coupon.applies_to_plan_codes || []
    }
  });
}));

/**
 * GET /platform/billing/usage/stream — Server-Sent Events feed of usage
 * counters for the current tenant. Emits every 5s while the connection
 * is open; client polls /usage on a 30s cadence as fallback.
 *
 * Architecture §8 — real-time signal for usage panels.
 */
router.get('/usage/stream', asyncHandler(async (req, res) => {
  // SSE headers — disable buffering so Node flushes per write.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  let alive = true;
  req.on('close', () => { alive = false; });

  const tick = async () => {
    if (!alive) return;
    try {
      const entitlements = await resolveEntitlements(req.orgId);
      const usage = await getUsageSummary({ tenantDb: req.tenantDb, orgId: req.orgId });
      const payload = {
        ts: new Date().toISOString(),
        period_end: usage.period_end,
        workflowsThisPeriod: usage.workflowsThisPeriod || 0,
        apiCallsToday: usage.apiCallsToday || 0,
        staffSeatsUsed: usage.staffSeatsUsed || 0,
        boardSeatsUsed: usage.boardSeatsUsed || 0,
        storageUsedGB: usage.storageUsedGB || 0,
        limits: entitlements.limits || {}
      };
      res.write(`event: usage\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err?.message || 'usage error' })}\n\n`);
    }
  };

  // Send one immediately so the client renders without a 5s wait.
  await tick();
  const interval = setInterval(tick, 5000);
  // Heartbeat so proxies don't reap idle sockets.
  const heartbeat = setInterval(() => {
    if (!alive) return;
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
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
    data: DEFAULT_FEATURE_FLAGS.map(([code, category, name, , description, sidebar]) => ({
      code, category, name, description: description || '', sidebar: sidebar || []
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

    const { SubscriptionPlan, OrganizationSubscription, Tenant, Coupon } = getRouterModels();
    const planCode = String(req.body.plan_code).toLowerCase();
    const billingCycle = req.body.billing_cycle || 'monthly';
    const rawCouponCode = req.body.coupon_code ? String(req.body.coupon_code).toUpperCase().trim() : null;

    const plan = await SubscriptionPlan.findOne({ plan_code: planCode, status: 'active', visibility: 'public' });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'Plan not available for self-checkout.' }
      });
    }

    // Resolve the locally-stored coupon → a Stripe `discounts` array we
    // can hand directly to checkout. Our admin creates coupons in Mongo;
    // we lazily mirror them to Stripe the first time they're used.
    let preBuiltDiscounts = null;       // [{ coupon: 'id' }] when we sync ourselves
    let fallbackCouponCode = null;      // raw string for Stripe to resolve as a last resort
    if (rawCouponCode) {
      console.log('[checkout] coupon code received:', rawCouponCode, 'orgId:', req.orgId);
      const localCoupon = await Coupon.findOne({ code: rawCouponCode });
      console.log('[checkout] local coupon:', localCoupon
        ? { code: localCoupon.code, status: localCoupon.status, percent_off: localCoupon.percent_off, amount_off_aud: localCoupon.amount_off_aud, applies_to: localCoupon.applies_to_plan_codes }
        : null);
      if (localCoupon && localCoupon.status !== 'archived') {
        // Plan-whitelist check — if the coupon restricts to certain plans
        // and this isn't one of them, reject so the tenant doesn't proceed
        // expecting a discount that won't apply.
        const whitelist = localCoupon.applies_to_plan_codes || [];
        if (whitelist.length > 0 && !whitelist.includes(planCode)) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'COUPON_NOT_APPLICABLE',
              message: `Coupon "${rawCouponCode}" doesn't apply to the ${plan.plan_name} plan.`
            }
          });
        }
        // Expiry / redemption checks (mirrored from /coupon/:code lookup
        // so a stale code can't sneak through if validation was skipped).
        if (localCoupon.redeem_by && new Date(localCoupon.redeem_by).getTime() < Date.now()) {
          return res.status(400).json({
            success: false,
            error: { code: 'COUPON_EXPIRED', message: 'This coupon has expired.' }
          });
        }
        if (localCoupon.max_redemptions && localCoupon.times_redeemed >= localCoupon.max_redemptions) {
          return res.status(400).json({
            success: false,
            error: { code: 'COUPON_FULLY_REDEEMED', message: 'This coupon has reached its redemption limit.' }
          });
        }

        // Match the coupon's currency to the line-item's currency.
        // Stripe rejects an AUD coupon on a USD price ("default currency
        // does not match the line item currency"). Only matters for
        // amount-off coupons; percent-off works universally.
        let priceCurrency = 'aud';
        const priceLookup = await retrievePrice(priceId);
        if (priceLookup.ok && priceLookup.price?.currency) {
          priceCurrency = priceLookup.price.currency;
        }
        console.log('[checkout] line-item price currency:', priceCurrency, 'price id:', priceId);

        const sync = await ensureStripeCouponForLocal(localCoupon, { currency: priceCurrency });
        console.log('[checkout] ensureStripeCouponForLocal:', sync);
        if (!sync.ok) {
          return res.status(502).json({
            success: false,
            error: { code: 'STRIPE_COUPON_SYNC_FAILED', message: sync.error || 'Could not sync coupon to Stripe.' }
          });
        }

        // Hand a fully-formed Stripe `discounts` array straight to the
        // session create — no second resolve, no chance of falling
        // through to allow_promotion_codes.
        preBuiltDiscounts = [{ coupon: sync.stripe_coupon_id }];

        // Persist the most-recently-used Stripe id as a hint for ops.
        if (!localCoupon.stripe_coupon_id || localCoupon.stripe_coupon_id !== sync.stripe_coupon_id) {
          localCoupon.stripe_coupon_id = sync.stripe_coupon_id;
          await localCoupon.save().catch(() => {});
        }
      } else {
        // No local mirror → pass the raw code straight to Stripe (might
        // resolve as a promotion code or Stripe-side coupon).
        console.warn('[checkout] no local coupon match — falling back to Stripe-side resolution for', rawCouponCode);
        fallbackCouponCode = rawCouponCode;
      }
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
    console.log('[checkout] creating Stripe session — discounts:', preBuiltDiscounts, 'fallback couponCode:', fallbackCouponCode);
    const session = await createCheckoutSession({
      customerId,
      priceId,
      orgId: req.orgId,
      planCode: plan.plan_code,
      billingCycle,
      successUrl: `${frontendBase}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${frontendBase}/billing?checkout=cancelled`,
      trialDays: plan.trial_days || 0,
      // Pre-built `discounts` wins; otherwise we fall back to letting
      // createCheckoutSession resolve the raw string against Stripe.
      discounts: preBuiltDiscounts,
      couponCode: fallbackCouponCode,
      setupFeePriceId
    });
    console.log('[checkout] Stripe session created:', session.id, 'total_details:', session.total_details);

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
