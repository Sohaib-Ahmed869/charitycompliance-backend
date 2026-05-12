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
import { resolveEntitlements, invalidateEntitlements } from '../../services/entitlementService.js';
import { getUsageSummary } from '../../services/usageMeterService.js';
import { mergePlansWithTemplates, DEFAULT_FEATURE_FLAGS } from '../../utils/defaultPlans.js';
import {
  isStripeConfigured,
  ensureStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  ensureStripeCouponForLocal,
  retrievePrice,
  retrieveSubscription,
  swapSubscriptionPrice,
  cancelAtPeriodEnd,
  restartSubscription,
  inspectCustomerCurrency,
  expireOpenCheckoutSessions,
  chargeOutstandingOverage
} from '../../services/stripeService.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
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

  // Outstanding-overage gate. Compute the same total the /usage endpoint
  // surfaces — if the tenant owes money for in-period overage that hasn't
  // been settled, refuse the cap edit. They must either pay it now (POST
  // /pay-overage-now) or wait for next period's invoice to clear it. This
  // is the "can't raise your spending limit while you have an unpaid
  // overage" rule the tenant asked for.
  const usage = await getUsageSummary({ tenantDb: req.tenantDb, orgId: req.orgId });
  const entitlements = await resolveEntitlements(req.orgId);
  const pricingForOverage = entitlements.pricing || {};
  const lookup = (metric) => {
    const rate = Number(pricingForOverage?.overageRatesAUD?.[metric]) || 0;
    if (rate > 0) return rate;
    if (metric === 'workflowsPerMonth') return Number(pricingForOverage?.overagePerWorkflowAUD) || 0;
    return 0;
  };
  const lim = entitlements.limits || {};
  const overageByMetric = {
    workflowsPerMonth: Math.max(0, (usage.workflowsThisPeriod || 0) - (Number(lim.workflowsPerMonth) > 0 ? Number(lim.workflowsPerMonth) : Infinity)) * lookup('workflowsPerMonth'),
    apiCallsPerDay:    Math.max(0, (usage.apiCallsToday || 0)       - (Number(lim.apiCallsPerDay)    > 0 ? Number(lim.apiCallsPerDay)    : Infinity)) * lookup('apiCallsPerDay'),
    staffSeats:        Math.max(0, (usage.staffSeatsActive || 0)    - (Number(lim.staffSeats)        > 0 ? Number(lim.staffSeats)        : Infinity)) * lookup('staffSeats'),
    boardSeats:        Math.max(0, (usage.boardSeatsActive || 0)    - (Number(lim.boardSeats)        > 0 ? Number(lim.boardSeats)        : Infinity)) * lookup('boardSeats'),
    storageGB:         Math.max(0, (usage.storageGBUsed || 0)       - (Number(lim.storageGB)         > 0 ? Number(lim.storageGB)         : Infinity)) * lookup('storageGB')
  };
  const totalOverageSpend = Object.values(overageByMetric).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const outstanding = Math.max(0, totalOverageSpend - (Number(sub.current_period_overage_paid_aud) || 0));
  if (outstanding > 0.005) {
    return res.status(402).json({
      success: false,
      error: {
        code: 'OVERAGE_UNPAID',
        message: `You have A$${outstanding.toFixed(2)} of overage charges still to settle from this billing period. Pay the outstanding amount before changing your spending cap.`,
        details: { outstanding_overage_aud: Math.round(outstanding * 100) / 100 }
      }
    });
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
  invalidateEntitlements(req.orgId);

  res.json({ success: true, data: { hard_cap_aud: sub.hard_cap_aud } });
}));

/**
 * POST /platform/billing/pay-overage-now
 *
 * Bill the tenant immediately for their in-period overage so they can
 * raise their cap / keep working without waiting for the next renewal
 * invoice. This is the "Pay outstanding overage" button on /billing.
 *
 * Idempotent — if a one-off overage invoice for the current period is
 * already open in Stripe, we return its hosted-invoice URL instead of
 * creating a duplicate.
 */
router.post('/pay-overage-now', asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
  }
  const { OrganizationSubscription } = getRouterModels();
  const sub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
  if (!sub) {
    return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No subscription on file.' } });
  }
  if (!sub.stripe_customer_id) {
    return res.status(409).json({ success: false, error: { code: 'NO_STRIPE_CUSTOMER', message: 'This subscription has no Stripe customer on file.' } });
  }

  // Recompute the outstanding amount (same calculation as /hard-cap and
  // /usage) so we always bill what the tenant actually owes right now —
  // never a stale snapshot.
  const usage = await getUsageSummary({ tenantDb: req.tenantDb, orgId: req.orgId });
  const entitlements = await resolveEntitlements(req.orgId);
  const pricingForOverage = entitlements.pricing || {};
  const lookup = (metric) => {
    const rate = Number(pricingForOverage?.overageRatesAUD?.[metric]) || 0;
    if (rate > 0) return rate;
    if (metric === 'workflowsPerMonth') return Number(pricingForOverage?.overagePerWorkflowAUD) || 0;
    return 0;
  };
  const lim = entitlements.limits || {};
  const totalSpend = [
    Math.max(0, (usage.workflowsThisPeriod || 0) - (Number(lim.workflowsPerMonth) > 0 ? Number(lim.workflowsPerMonth) : Infinity)) * lookup('workflowsPerMonth'),
    Math.max(0, (usage.apiCallsToday || 0)       - (Number(lim.apiCallsPerDay)    > 0 ? Number(lim.apiCallsPerDay)    : Infinity)) * lookup('apiCallsPerDay'),
    Math.max(0, (usage.staffSeatsActive || 0)    - (Number(lim.staffSeats)        > 0 ? Number(lim.staffSeats)        : Infinity)) * lookup('staffSeats'),
    Math.max(0, (usage.boardSeatsActive || 0)    - (Number(lim.boardSeats)        > 0 ? Number(lim.boardSeats)        : Infinity)) * lookup('boardSeats'),
    Math.max(0, (usage.storageGBUsed || 0)       - (Number(lim.storageGB)         > 0 ? Number(lim.storageGB)         : Infinity)) * lookup('storageGB')
  ].reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const outstandingAud = Math.max(0, Math.round((totalSpend - (Number(sub.current_period_overage_paid_aud) || 0)) * 100) / 100);

  if (outstandingAud <= 0) {
    return res.status(409).json({
      success: false,
      error: { code: 'NOTHING_TO_PAY', message: 'You have no outstanding overage charges right now.' }
    });
  }

  // Build the success/cancel URLs the tenant will be redirected to
  // after the Stripe Checkout completes. MUST be the FRONTEND origin
  // (Vite dev: localhost:5173, prod: stewardex.tech), never req.host
  // which resolves to the backend on localhost:5000 and 404s.
  const origin = serverConfig.frontendUrl;
  const successUrl = `${origin}/billing?overage_paid=1&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${origin}/billing?overage_paid=0`;

  const charge = await chargeOutstandingOverage({
    customerId: sub.stripe_customer_id,
    amountAUD: outstandingAud,
    description: `Overage charges — ${usage.period_start?.toISOString?.()?.slice(0,10) || 'current period'}`,
    successUrl,
    cancelUrl,
    metadata: {
      orgId: req.orgId,
      period_start: usage.period_start?.toISOString?.() || '',
      expected_amount_aud: String(outstandingAud)
    }
  });

  if (!charge.ok) {
    return res.status(502).json({
      success: false,
      error: {
        code: 'OVERAGE_CHECKOUT_FAILED',
        message: charge.error || 'Could not start a Stripe checkout session for the overage.'
      }
    });
  }

  // We do NOT credit the paid amount yet — only the `checkout.session
  // .completed` webhook (handled in stripeWebhookRoutes.js) confirms
  // the actual payment. Until then the tenant remains "frozen" and
  // can re-open the modal to retry.
  await writeBillingEvent(req, {
    action: 'subscription.overage_paynow_started',
    targetType: 'subscription',
    targetId: req.orgId,
    targetLabel: req.orgId,
    tenantId: req.orgId,
    reason: `Tenant opened Stripe checkout for A$${outstandingAud.toFixed(2)} overage`,
    metadata: {
      amount_aud: outstandingAud,
      stripe_session_id: charge.session_id,
      stripe_customer_id: sub.stripe_customer_id
    }
  });

  res.json({
    success: true,
    data: {
      amount_aud: outstandingAud,
      checkout_url: charge.checkout_url,
      stripe_session_id: charge.session_id
    }
  });
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
 * GET /platform/billing/usage/export
 * Query: { from?, to?, format? = 'csv' | 'json' }
 *
 * Streams the tenant's UsageEvent log (or a date-bounded subset) as CSV
 * (default) or JSON. Lets accountants pull metering data into their
 * own tools instead of screen-scraping the dashboard.
 */
/**
 * GET /platform/billing/payments/export
 *
 * Returns every payment row this tenant has — paid, failed, refunded
 * and pending — as either CSV (default) or JSON. Pulled from the
 * Router DB's `payments` collection which is the same source the
 * Calcite-admin invoice browser reads; the tenant just gets a
 * scoped, read-only export of their own.
 *
 * Query params:
 *   ?format=csv|json   default csv
 *   ?from=ISO_DATE     payment_date >= from
 *   ?to=ISO_DATE       payment_date <= to
 *   ?status=succeeded|failed|pending|refunded   optional filter
 */
router.get('/payments/export', asyncHandler(async (req, res) => {
  const { Payment } = getRouterModels();
  const filter = { organization_id: req.orgId };
  if (req.query.from || req.query.to) {
    filter.payment_date = {};
    if (req.query.from) filter.payment_date.$gte = new Date(req.query.from);
    if (req.query.to)   filter.payment_date.$lte = new Date(req.query.to);
  }
  if (req.query.status && ['succeeded', 'failed', 'pending', 'refunded'].includes(req.query.status)) {
    filter.status = req.query.status;
  }

  const payments = await Payment.find(filter).sort({ payment_date: -1 }).limit(50000).lean();
  const format = (req.query.format || 'csv').toLowerCase();

  // JSON path — straight passthrough for programmatic consumers.
  if (format === 'json') {
    return res.json({
      success: true,
      data: payments.map((p) => ({
        payment_date: p.payment_date,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        description: p.description || '',
        stripe_payment_id: p.stripe_payment_id || '',
        stripe_payment_intent_id: p.stripe_payment_intent_id || '',
        stripe_invoice_id: p.stripe_invoice_id || '',
        failure_reason: p.failure_reason || '',
        invoice_number: p.metadata?.invoice_number || ''
      }))
    });
  }

  // CSV path — RFC-4180-friendly. Quote anything with delimiters /
  // quotes / newlines and double-up internal quotes. Excel-compatible
  // (BOM is added so Excel auto-detects UTF-8 with currency symbols).
  const cols = [
    'payment_date',
    'amount',
    'currency',
    'status',
    'description',
    'invoice_number',
    'stripe_invoice_id',
    'stripe_payment_id',
    'stripe_payment_intent_id',
    'failure_reason'
  ];
  const escape = (val) => {
    if (val == null) return '';
    const str = val instanceof Date ? val.toISOString() : (typeof val === 'object' ? JSON.stringify(val) : String(val));
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const header = cols.join(',');
  const rows = payments.map((p) => {
    const row = {
      payment_date: p.payment_date,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      description: p.description || '',
      invoice_number: p.metadata?.invoice_number || '',
      stripe_invoice_id: p.stripe_invoice_id || '',
      stripe_payment_id: p.stripe_payment_id || '',
      stripe_payment_intent_id: p.stripe_payment_intent_id || '',
      failure_reason: p.failure_reason || ''
    };
    return cols.map((c) => escape(row[c])).join(',');
  });

  const filename = `stewardex-payments-${req.orgId}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // ﻿ = UTF-8 BOM so Excel renders currency / accented chars correctly.
  res.send('﻿' + [header, ...rows].join('\n'));
}));

router.get('/usage/export', asyncHandler(async (req, res) => {
  const usageEventSchema = (await import('../../db/schemas/platform/usageEventSchema.js')).default;
  const UsageEvent = req.tenantDb.models.UsageEvent || req.tenantDb.model('UsageEvent', usageEventSchema);

  const filter = {};
  if (req.query.from) filter.ts = { ...(filter.ts || {}), $gte: new Date(req.query.from) };
  if (req.query.to)   filter.ts = { ...(filter.ts || {}), $lte: new Date(req.query.to)   };

  const events = await UsageEvent.find(filter).sort({ ts: -1 }).limit(10000).lean();
  const format = (req.query.format || 'csv').toLowerCase();

  if (format === 'json') {
    res.json({ success: true, data: events });
    return;
  }

  // CSV — minimal, RFC-4180-friendly. Quote any value containing
  // delimiters/quotes/newlines and double-up internal quotes.
  const cols = ['ts', 'event_code', 'event_id', 'counts_as_workflow', 'storage_delta_bytes', 'aggregated_at', 'payload'];
  const escape = (val) => {
    if (val == null) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const header = cols.join(',');
  const rows = events.map((e) => cols.map((c) => escape(e[c])).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stewardex-usage-${req.orgId}-${Date.now()}.csv"`);
  res.send([header, ...rows].join('\n'));
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
  const pricing = entitlements.pricing || {};
  const hardCapAud = entitlements.hard_cap_aud ?? null;

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
      softCap, hardCap, pricing, hardCapAud
    }),
    buildItem({
      key: 'apiCallsPerDay',
      label: 'Feature actions',
      caption: 'Submissions, approvals, and other feature actions today',
      kind: 'metered',
      used: usage.apiCallsToday ?? 0,
      limit: limits.apiCallsPerDay,
      resetAt: dailyResetAt,
      resetCadence: 'daily',
      softCap, hardCap, pricing, hardCapAud
    }),
    buildItem({
      key: 'staffSeats',
      label: 'Staff seats',
      caption: 'Active staff users in this organisation',
      kind: 'allocation',
      used: usage.staffSeatsActive,
      limit: limits.staffSeats,
      softCap, hardCap, pricing, hardCapAud
    }),
    buildItem({
      key: 'boardSeats',
      label: 'Board seats',
      caption: 'Active responsible-people / board members',
      kind: 'allocation',
      used: usage.boardSeatsActive,
      limit: limits.boardSeats,
      softCap, hardCap, pricing, hardCapAud
    }),
    buildItem({
      key: 'storageGB',
      label: 'Storage',
      caption: 'Documents and attachments',
      kind: 'allocation',
      used: usage.storageGBUsed,
      limit: limits.storageGB,
      unitSuffix: 'GB',
      softCap, hardCap, pricing, hardCapAud
    })
  ];

  // Aggregate overage owed across all metrics, net of what the tenant
  // has already paid for this period. Powers the "Pay $X outstanding
  // overage" CTA and the cap-edit gate on the tenant's billing page.
  const totalOverageSpendAud = items.reduce(
    (sum, it) => sum + (it.overage?.spend_aud_so_far || 0),
    0
  );
  const paidAud = await getRouterModels().OrganizationSubscription
    .findOne({ organization_id: req.orgId })
    .select('current_period_overage_paid_aud current_period_overage_invoice_id')
    .lean()
    .then((s) => Number(s?.current_period_overage_paid_aud) || 0)
    .catch(() => 0);
  const outstandingOverageAud = Math.max(0, Math.round((totalOverageSpendAud - paidAud) * 100) / 100);

  res.json({
    success: true,
    data: {
      period_start: usage.period_start,
      period_end: usage.period_end,
      items,
      soft_cap_pct: limits.softCapPct ?? 80,
      hard_cap_pct: limits.hardCapPct ?? 100,
      // Claude/Cursor-style overage state. Both numbers in AUD.
      //   total_overage_spend_aud — cumulative cost of overages this period
      //   paid_overage_aud        — what the tenant has already settled
      //   outstanding_overage_aud — what they still owe (drives the CTA)
      total_overage_spend_aud: Math.round(totalOverageSpendAud * 100) / 100,
      paid_overage_aud: Math.round(paidAud * 100) / 100,
      outstanding_overage_aud: outstandingOverageAud,
      hard_cap_locked: outstandingOverageAud > 0
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

/**
 * GET /platform/billing/events/export
 *
 * Tenant-facing export of every BillingEvent that has affected this
 * org — plan changes, overage settlements, custom-override edits,
 * support visits, hard-cap changes, etc. The PDF / CSV is rendered
 * client-side; this route just streams the raw rows in JSON for the
 * frontend to format.
 */
router.get('/events/export', asyncHandler(async (req, res) => {
  const { BillingEvent } = getRouterModels();
  const filter = { tenant_id: req.orgId };
  if (req.query.from || req.query.to) {
    filter.created_at = {};
    if (req.query.from) filter.created_at.$gte = new Date(req.query.from);
    if (req.query.to)   filter.created_at.$lte = new Date(req.query.to);
  }
  const events = await BillingEvent
    .find(filter)
    .sort({ created_at: -1 })
    .limit(5000)
    .lean();
  res.json({
    success: true,
    data: events.map((e) => ({
      created_at: e.created_at,
      action: e.action,
      target_type: e.target_type || '',
      target_label: e.target_label || '',
      reason: e.reason || '',
      actor_email: e.actor_email || ''
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

    // Resolve the Stripe price up-front — the coupon-currency lookup
    // below needs it, so we can't defer the declaration.
    const priceId = billingCycle === 'yearly' ? plan.pricing?.stripeAnnualPriceId : plan.pricing?.stripeMonthlyPriceId;
    if (!priceId) {
      return res.status(409).json({
        success: false,
        error: { code: 'STRIPE_PRICE_MISSING', message: 'This plan has no Stripe price for that cycle. Contact support.' }
      });
    }

    // Resolve the price's currency up-front. Stripe locks a customer to
    // the currency of their first commitment (subscription, invoice, or
    // even an unexpired Checkout Session), so we need this for both the
    // coupon-currency match below and the customer-reuse check further
    // down. Computing it once avoids a duplicate retrievePrice call.
    const priceLookupForCustomer = await retrievePrice(priceId);
    const desiredCurrency = (priceLookupForCustomer.price?.currency || 'aud').toLowerCase();

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
        // Stripe rejects an AUD coupon on a USD price. The currency was
        // resolved further up the route (before the customer check) so
        // we reuse it here without a second retrievePrice call.
        const priceCurrency = (typeof desiredCurrency === 'string' && desiredCurrency)
          ? desiredCurrency
          : 'aud';
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

    // Ensure customer + reuse the existing one if the tenant has subscribed before.
    // `desiredCurrency` was resolved up-front (right after the priceId
    // block) so both the coupon-sync above and the conflict check below
    // share a single price lookup.
    const existingSub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
    let customerId = existingSub?.stripe_customer_id;
    if (customerId) {
      // Currency-sanity check on the reused customer.
      const inspect = await inspectCustomerCurrency(customerId);
      if (inspect.ok && inspect.currency && inspect.currency !== desiredCurrency) {
        console.warn('[checkout] customer currency conflict', {
          customerId,
          locked_to: inspect.currency,
          desired: desiredCurrency,
          customerCurrencyPinned: inspect.customerCurrencyPinned,
          hasActiveSubscription: inspect.hasActiveSubscription,
          hasOpenCheckout: inspect.hasOpenCheckout
        });
        if (inspect.customerCurrencyPinned) {
          // Stripe's customer.currency is permanently set — no amount
          // of session-expiry will release this. Orphan and mint new.
          console.warn('[checkout] customer.currency permanently pinned — minting fresh customer.');
          customerId = null;
        } else if (inspect.hasOpenCheckout && !inspect.hasActiveSubscription) {
          // Currency reserved by an open session but not yet pinned on
          // the customer object — expiring the session releases it.
          const exp = await expireOpenCheckoutSessions(customerId);
          console.log('[checkout] expired open sessions to release currency lock:', exp);
          const recheck = await inspectCustomerCurrency(customerId);
          if (!(recheck.ok && (!recheck.currency || recheck.currency === desiredCurrency))) {
            // Still locked after expiry → orphan.
            customerId = null;
          }
        } else {
          // Active sub/invoice in another currency → orphan and mint.
          customerId = null;
        }
      }
    }
    if (!customerId) {
      const tenant = await Tenant.findOne({ orgId: req.orgId }).lean();
      const customer = await ensureStripeCustomer({
        orgId: req.orgId,
        email: req.user?.email,
        name: tenant?.orgId || req.orgId
      });
      customerId = customer.id;
      // Persist the new customer id so future checkouts reuse the
      // fresh, currency-clean one instead of the stuck old one.
      if (existingSub && existingSub.stripe_customer_id !== customerId) {
        existingSub.stripe_customer_id = customerId;
        await existingSub.save().catch(() => {});
      }
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
/**
 * Look up the per-unit overage rate for a metric. Mirrors the helper in
 * enforceLimit.js — kept inline here so the usage report doesn't depend
 * on importing middleware code.
 */
function lookupOverageRate(pricing, metric) {
  if (!pricing) return 0;
  const fromMap = Number(pricing?.overageRatesAUD?.[metric]) || 0;
  if (fromMap > 0) return fromMap;
  if (metric === 'workflowsPerMonth') return Number(pricing?.overagePerWorkflowAUD) || 0;
  return 0;
}

function buildItem({
  key, label, caption, kind = 'metered',
  used, limit, resetAt, resetCadence,
  unitSuffix, softCap = 0.8, hardCap = 1.0, tracking = true,
  pricing = null, hardCapAud = null
}) {
  const usedNum = Number(used || 0);
  const lim = limit == null ? 0 : Number(limit);
  const unlimited = lim === -1;
  const noLimit = lim === 0;
  const ratio = unlimited || lim <= 0 ? 0 : usedNum / lim;

  // Overage economics — per-metric rate, units over, dollars spent so
  // far this cycle, and how much of the tenant's self-set budget that
  // represents. Surfaces "$4 of $22 overage budget used" in the UI.
  const overageRate = lookupOverageRate(pricing, key);
  const unitsOver = Math.max(0, usedNum - (unlimited ? Infinity : lim));
  const overageSpendAud = overageRate > 0 && Number.isFinite(unitsOver) ? overageRate * unitsOver : 0;
  const capAud = hardCapAud != null ? Number(hardCapAud) : null;
  const overageBudgetPct = capAud && capAud > 0 ? Math.min(100, Math.round((overageSpendAud / capAud) * 100)) : null;

  let status = 'healthy';
  if (!tracking) status = 'not_tracked';
  else if (unlimited) status = 'unlimited';
  else if (noLimit) status = 'not_included';
  else if (ratio >= hardCap) {
    // Differentiate "blocked" (no overage available) from "in overage"
    // (overage available and being billed). The FE picks different
    // labels — "Quota used up" vs "Now in overage" — based on this.
    status = overageRate > 0 ? 'in_overage' : 'at_limit';
  }
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
    reset_cadence: resetCadence || null,
    // Overage economics — null when no overage rate is configured for
    // this metric.
    overage: overageRate > 0 ? {
      rate_aud_per_unit: overageRate,
      units_over: unitsOver,
      spend_aud_so_far: Math.round(overageSpendAud * 100) / 100,
      cap_aud: capAud,
      budget_pct_used: overageBudgetPct
    } : null
  };
}

// ════════════════════════════════════════════════════════════════════
// TENANT SELF-SERVE BILLING ACTIONS (handbook §3.4 / arch §11)
// ════════════════════════════════════════════════════════════════════

/**
 * POST /platform/billing/change-plan
 * Body: { plan_code, billing_cycle, mode? }
 * Org owner / admin moves their tenant to a different plan.
 *   - mode 'immediately_prorated' (default for upgrades) — Stripe applies a
 *     prorated charge/refund for the current cycle.
 *   - mode 'at_renewal' (default for downgrades) — change locally now;
 *     Stripe swaps to the new price at the next cycle anchor.
 */
router.post(
  '/change-plan',
  [
    body('plan_code').isString().trim().notEmpty(),
    body('billing_cycle').optional().isIn(['monthly', 'yearly']),
    body('mode').optional().isIn(['at_renewal', 'immediately_prorated'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured.' } });
    }
    const { SubscriptionPlan, OrganizationSubscription, PlanRevision } = getRouterModels();
    const orgId = req.orgId;
    const newPlanCode = String(req.body.plan_code).toLowerCase();
    const newCycle = req.body.billing_cycle || 'monthly';

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub) {
      return res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No subscription on file. Start a checkout first.' } });
    }
    const newPlan = await SubscriptionPlan.findOne({ plan_code: newPlanCode, status: 'active', visibility: 'public' });
    if (!newPlan) {
      return res.status(404).json({ success: false, error: { code: 'PLAN_NOT_FOUND', message: 'That plan is not available for self-serve change.' } });
    }
    const newPriceId = newCycle === 'yearly' ? newPlan.pricing?.stripeAnnualPriceId : newPlan.pricing?.stripeMonthlyPriceId;
    if (!newPriceId) {
      return res.status(409).json({ success: false, error: { code: 'STRIPE_PRICE_MISSING', message: 'Selected plan/cycle has no Stripe price configured. Contact billing.' } });
    }

    // Decide proration default by direction. Compare on monthly amount.
    const oldPlan = await SubscriptionPlan.findById(sub.plan_id).lean();
    const oldMonthly = Number(oldPlan?.pricing?.monthlyAUD || 0);
    const newMonthly = Number(newPlan.pricing?.monthlyAUD || 0);
    const isUpgrade = newMonthly > oldMonthly;
    const mode = req.body.mode || (isUpgrade ? 'immediately_prorated' : 'at_renewal');

    // Stripe swap (only when there's a live Stripe sub to update).
    let stripeSwap = null;
    if (sub.stripe_subscription_id) {
      const swap = await swapSubscriptionPrice({
        subscriptionId: sub.stripe_subscription_id,
        newPriceId,
        proration: mode === 'immediately_prorated' ? 'create_prorations' : 'none'
      });
      if (!swap.ok) {
        return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: swap.error } });
      }
      stripeSwap = { ok: true, mode };
    }

    // Update local record. If mode is 'at_renewal', the local plan_id
    // changes too — the next webhook (subscription.updated) will reconcile
    // the period dates.
    const latestRevision = await PlanRevision.findOne({ plan_id: newPlan._id }).sort({ revision_number: -1 }).lean();
    sub.plan_id = newPlan._id;
    sub.plan_revision_id = latestRevision?._id || null;
    sub.plan_revision_number = latestRevision?.revision_number || null;
    sub.billing_cycle = newCycle;
    await sub.save();

    invalidateEntitlements(orgId);
    await writeBillingEvent(req, {
      action: 'subscription.changed',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: `Tenant self-serve change → ${newPlan.plan_name}`,
      metadata: {
        from_plan_code: oldPlan?.plan_code || null,
        to_plan_code: newPlan.plan_code,
        billing_cycle: newCycle,
        migration_mode: mode,
        stripe_swap: stripeSwap,
        triggered_by: 'tenant_self_serve'
      }
    });

    res.json({ success: true, data: { plan_code: newPlan.plan_code, billing_cycle: newCycle, mode } });
  })
);

/**
 * POST /platform/billing/switch-cycle
 * Body: { billing_cycle }
 * Same plan, different cycle. Convenience wrapper around /change-plan.
 */
router.post(
  '/switch-cycle',
  [body('billing_cycle').isIn(['monthly', 'yearly'])],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured.' } });
    }
    const { SubscriptionPlan, OrganizationSubscription } = getRouterModels();
    const orgId = req.orgId;
    const newCycle = req.body.billing_cycle;

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No live Stripe subscription on file.' } });
    }
    if (sub.billing_cycle === newCycle) {
      return res.status(409).json({ success: false, error: { code: 'CYCLE_UNCHANGED', message: `Already on ${newCycle} billing.` } });
    }
    const plan = await SubscriptionPlan.findById(sub.plan_id);
    const newPriceId = newCycle === 'yearly' ? plan?.pricing?.stripeAnnualPriceId : plan?.pricing?.stripeMonthlyPriceId;
    if (!newPriceId) {
      return res.status(409).json({ success: false, error: { code: 'STRIPE_PRICE_MISSING', message: `${newCycle} pricing isn't configured for your plan.` } });
    }

    const swap = await swapSubscriptionPrice({
      subscriptionId: sub.stripe_subscription_id,
      newPriceId,
      // Yearly switch should prorate (huge difference); monthly switch
      // can defer to next cycle to avoid surprises.
      proration: newCycle === 'yearly' ? 'create_prorations' : 'none'
    });
    if (!swap.ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: swap.error } });
    }

    sub.billing_cycle = newCycle;
    await sub.save();
    invalidateEntitlements(orgId);

    await writeBillingEvent(req, {
      action: 'subscription.changed',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: `Cycle switched to ${newCycle}`,
      metadata: { billing_cycle: newCycle, triggered_by: 'tenant_self_serve' }
    });

    res.json({ success: true, data: { billing_cycle: newCycle } });
  })
);

/**
 * POST /platform/billing/cancel
 * Body: { reason?, feedback? }
 * Tenant cancels their own subscription. Soft cancel — access continues
 * until the end of the current period (Stripe `cancel_at_period_end`).
 */
router.post(
  '/cancel',
  [
    body('reason').optional().isString().trim().isLength({ max: 500 }),
    body('feedback').optional().isString().trim().isLength({ max: 1000 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured.' } });
    }
    const { OrganizationSubscription } = getRouterModels();
    const orgId = req.orgId;
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No live Stripe subscription to cancel.' } });
    }

    const result = await cancelAtPeriodEnd({
      subscriptionId: sub.stripe_subscription_id,
      cancellationDetails: req.body?.feedback ? { comment: req.body.feedback } : undefined
    });
    if (!result.ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: result.error } });
    }

    sub.cancel_at_period_end = true;
    await sub.save();
    invalidateEntitlements(orgId);

    await writeBillingEvent(req, {
      action: 'subscription.cancelled',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body?.reason || 'Tenant requested cancellation',
      metadata: {
        feedback: req.body?.feedback || null,
        cancels_on: sub.current_period_end,
        triggered_by: 'tenant_self_serve'
      }
    });

    res.json({
      success: true,
      data: {
        cancels_on: sub.current_period_end,
        message: `Your subscription will end on ${new Date(sub.current_period_end).toLocaleDateString()}. You can reverse this any time before then.`
      }
    });
  })
);

/**
 * POST /platform/billing/restart
 * Undo a pending end-of-period cancellation.
 */
router.post('/restart', asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured.' } });
  }
  const { OrganizationSubscription } = getRouterModels();
  const sub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
  if (!sub?.stripe_subscription_id) {
    return res.status(404).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No live Stripe subscription on file.' } });
  }
  if (!sub.cancel_at_period_end) {
    return res.status(409).json({ success: false, error: { code: 'NOT_CANCELLED', message: 'Your subscription is not scheduled for cancellation.' } });
  }
  const result = await restartSubscription({ subscriptionId: sub.stripe_subscription_id });
  if (!result.ok) {
    return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: result.error } });
  }
  sub.cancel_at_period_end = false;
  await sub.save();
  invalidateEntitlements(req.orgId);

  await writeBillingEvent(req, {
    action: 'subscription.resumed',
    targetType: 'subscription',
    targetId: req.orgId,
    targetLabel: req.orgId,
    tenantId: req.orgId,
    reason: 'Tenant un-cancelled before period end',
    metadata: { triggered_by: 'tenant_self_serve' }
  });

  res.json({ success: true, data: { cancelled: false } });
}));

export default router;
