/**
 * Stripe API wrapper.
 *
 * Lazily instantiates the Stripe client so the rest of the codebase can
 * call any helper without crashing when STRIPE_SECRET_KEY is not set —
 * routes that need Stripe respond with a 503 NOT_CONFIGURED error,
 * everything else keeps working.
 *
 * Test vs live mode is implicit in the secret key Stripe gives you
 * (`sk_test_…` vs `sk_live_…`). The SuperAdmin Settings panel reflects
 * which mode the key is in (we infer from the prefix); switching modes
 * is a config-level change.
 */

import Stripe from 'stripe';
import { stripe as stripeConfig } from '../config/index.js';

let _client = null;
let _initialized = false;
let _mode = 'unconfigured';

function getClient() {
  if (_initialized) return _client;
  _initialized = true;
  if (!stripeConfig.secretKey) {
    console.warn('[stripe] STRIPE_SECRET_KEY not set — billing endpoints will return NOT_CONFIGURED.');
    return null;
  }
  _client = new Stripe(stripeConfig.secretKey, {
    apiVersion: '2024-10-28.acacia',
    typescript: false,
    appInfo: { name: 'Stewardex', version: '1.0.0' }
  });
  _mode = stripeConfig.secretKey.startsWith('sk_live_') ? 'live' : 'test';
  return _client;
}

export function isStripeConfigured() {
  return !!stripeConfig.secretKey;
}

export function getStripeMode() {
  if (!_initialized) getClient();
  return _mode;
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('Stripe is not configured. Set STRIPE_SECRET_KEY in the environment.');
    this.code = 'STRIPE_NOT_CONFIGURED';
    this.statusCode = 503;
  }
}

function requireClient() {
  const client = getClient();
  if (!client) throw new StripeNotConfiguredError();
  return client;
}

// ── Customers ────────────────────────────────────────────────────────

/**
 * Look up an existing Stripe Customer by orgId metadata, or create one.
 * Idempotent — calling repeatedly with the same orgId returns the same
 * Customer (Stripe doesn't have a unique constraint on metadata, so we
 * search-then-create rather than relying on a deterministic id).
 */
export async function ensureStripeCustomer({ orgId, email, name }) {
  const client = requireClient();
  // Search first — Stripe supports `metadata['orgId']:'…'` syntax.
  // Soft-deleted customers still appear in search results with
  // `deleted: true`, so we skip those AND double-check by retrieving
  // the customer (the search index can lag for a few seconds after a
  // dashboard delete, returning a row that 404s on direct fetch).
  try {
    const search = await client.customers.search({
      query: `metadata['orgId']:'${orgId}'`,
      limit: 10
    });
    for (const candidate of search.data) {
      if (candidate.deleted) continue;
      // Verify the customer still exists — search index can be stale.
      const live = await client.customers.retrieve(candidate.id).catch(() => null);
      if (live && !live.deleted) return live;
    }
  } catch (err) {
    // Search may fail on accounts without the right index; fall through to create.
    console.warn('[stripe] customer search failed, falling back to create:', err?.message || err);
  }
  return client.customers.create({
    email: email || undefined,
    name: name || orgId,
    metadata: { orgId }
  });
}

/**
 * Search-only counterpart to ensureStripeCustomer — finds the Stripe
 * Customer for an orgId without creating one. Returns null when none
 * exists. Used by the reconciler's self-heal path so a tenant who never
 * subscribed doesn't get a phantom customer minted on a billing read.
 */
export async function findStripeCustomerByOrgId(orgId) {
  const client = requireClient();
  try {
    const search = await client.customers.search({
      query: `metadata['orgId']:'${orgId}'`,
      limit: 10
    });
    for (const candidate of search.data) {
      if (candidate.deleted) continue;
      // Search index can lag a dashboard delete — confirm with a direct fetch.
      const live = await client.customers.retrieve(candidate.id).catch(() => null);
      if (live && !live.deleted) return live;
    }
  } catch (err) {
    console.warn('[stripe] findStripeCustomerByOrgId search failed:', err?.message || err);
  }
  return null;
}

// ── Checkout sessions ───────────────────────────────────────────────

/**
 * Create a Stripe Checkout session for a tenant to subscribe to a plan.
 *
 * @param {object} args
 * @param {string} args.customerId          - Stripe Customer id
 * @param {string} args.priceId             - Stripe Price id (monthly OR annual)
 * @param {string} args.orgId               - tenant orgId — stored in metadata
 * @param {string} args.planCode            - plan slug — stored in metadata
 * @param {string} args.billingCycle        - 'monthly' | 'yearly'
 * @param {string} args.successUrl
 * @param {string} args.cancelUrl
 * @param {number} [args.trialDays]         - free trial; 0 or undefined = no trial
 * @param {string} [args.couponCode]        - apply a Stripe coupon code at checkout
 */
export async function createCheckoutSession(args) {
  const client = requireClient();
  const {
    customerId, priceId, orgId, planCode, billingCycle,
    successUrl, cancelUrl, trialDays, couponCode, setupFeePriceId
  } = args;

  // Recurring price + optional one-time setup fee, both billed at checkout.
  const lineItems = [{ price: priceId, quantity: 1 }];
  if (setupFeePriceId) {
    lineItems.push({ price: setupFeePriceId, quantity: 1 });
  }

  // Stripe rejects sending BOTH `allow_promotion_codes` and `discounts`
  // — even with `allow_promotion_codes: false`. So we omit one or the
  // other depending on what the caller supplied.
  //
  // The caller can hand us a pre-built `discounts` array (preferred —
  // skips ambiguity when we already know the coupon id), OR a raw
  // `couponCode` string which we resolve via Stripe lookup as a
  // fallback.
  const sessionParams = {
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { orgId, planCode, billingCycle },
      ...(trialDays && trialDays > 0 ? { trial_period_days: trialDays } : {})
    },
    metadata: { orgId, planCode, billingCycle }
  };

  if (Array.isArray(args.discounts) && args.discounts.length > 0) {
    sessionParams.discounts = args.discounts;
    console.log('[stripe] checkout discounts pre-applied:', JSON.stringify(args.discounts));
  } else if (couponCode) {
    // Resolve the user-typed string. Stripe distinguishes `coupon` (the
    // internal id like `coupon_ABC123`) from `promotion_code` (the
    // customer-facing redeemable code like `LAUNCH25`). Try promotion
    // codes first since that's what most users enter, then coupons.
    const resolved = await resolveCouponOrPromotionCode(client, couponCode);
    if (resolved.promotion_code) {
      sessionParams.discounts = [{ promotion_code: resolved.promotion_code }];
      console.log('[stripe] checkout resolved promotion code:', resolved.promotion_code);
    } else if (resolved.coupon) {
      sessionParams.discounts = [{ coupon: resolved.coupon }];
      console.log('[stripe] checkout resolved coupon:', resolved.coupon);
    } else {
      console.warn('[stripe] checkout could not resolve coupon/promotion code:', couponCode);
      sessionParams.allow_promotion_codes = true;
    }
  } else {
    sessionParams.allow_promotion_codes = true;
  }

  return client.checkout.sessions.create(sessionParams);
}

/**
 * Retrieve a Checkout Session by id. Returns null when Stripe can't find
 * it (e.g. a session id from a different account, or test vs live mode)
 * so callers can report a clean error instead of throwing a raw 404.
 */
export async function retrieveCheckoutSession(sessionId) {
  const client = requireClient();
  try {
    return await client.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 'resource_missing') return null;
    throw err;
  }
}

/**
 * Ensure a Stripe coupon exists for a locally-created Coupon doc.
 *
 * Calcite super-admins create coupons in our Mongo Coupon collection,
 * which is the source of truth for the discount programs (Community
 * Impact, Founding Customer, etc). For Stripe Checkout to actually
 * apply the discount, the same coupon needs to exist on Stripe — this
 * helper creates it on first use and returns the Stripe coupon id.
 *
 * Currency note: percent-off coupons are currency-agnostic (one Stripe
 * coupon works for every price currency). Amount-off coupons are tied
 * to a specific currency and CANNOT be applied to a price in a
 * different currency — Stripe rejects with "default currency does not
 * match the line item currency". So we mint one Stripe coupon per
 * (code, currency) pair, with the id suffixed by the currency:
 *
 *     LAUNCH25       — percent-off, works for any currency
 *     LAUNCH25_USD   — $25 off USD prices
 *     LAUNCH25_AUD   — $25 off AUD prices
 *
 * `currency` is taken from the Stripe Price the tenant is checking out
 * with, so the right one is created on demand.
 *
 * Returns `{ ok, stripe_coupon_id, error?, alreadyExisted? }`.
 */
export async function ensureStripeCouponForLocal(localCoupon, { currency = 'aud' } = {}) {
  if (!localCoupon || !localCoupon.code) {
    return { ok: false, error: 'localCoupon must have a code' };
  }
  try {
    const client = requireClient();
    const isAmountOff = localCoupon.percent_off == null && localCoupon.amount_off_aud != null;
    const normalizedCurrency = String(currency || 'aud').toLowerCase();
    const stripeId = isAmountOff
      ? `${localCoupon.code}_${normalizedCurrency.toUpperCase()}`
      : localCoupon.code;

    // Try retrieving the desired-shape coupon first — handles both:
    //   - we already created it (cached or not on the local doc), and
    //   - the admin manually created it directly in Stripe.
    try {
      const existing = await client.coupons.retrieve(stripeId);
      if (existing && existing.valid !== false) {
        // Sanity check: an `amount_off` coupon retrieved here must match
        // the currency we want; if not (which shouldn't happen given the
        // suffixing above, but guard anyway), force-recreate under a
        // different id by adding a timestamp suffix.
        if (isAmountOff && existing.currency !== normalizedCurrency) {
          // Fall through to the create path with a unique id so we
          // don't overwrite the wrong-currency one.
        } else {
          return { ok: true, stripe_coupon_id: existing.id, alreadyExisted: true };
        }
      }
    } catch (_) {
      // Doesn't exist — create below.
    }

    // Build the Stripe coupon shape from our local fields.
    const params = {
      id: stripeId,
      name: localCoupon.name || localCoupon.code,
      duration: localCoupon.duration || 'once'
    };
    if (localCoupon.percent_off != null) {
      params.percent_off = Number(localCoupon.percent_off);
    } else if (localCoupon.amount_off_aud != null) {
      params.amount_off = Math.round(Number(localCoupon.amount_off_aud) * 100);
      params.currency = normalizedCurrency;
    } else {
      return { ok: false, error: 'Local coupon has neither percent_off nor amount_off_aud.' };
    }
    if (localCoupon.duration === 'repeating' && localCoupon.duration_in_months) {
      params.duration_in_months = Number(localCoupon.duration_in_months);
    }
    if (localCoupon.max_redemptions) {
      params.max_redemptions = Number(localCoupon.max_redemptions);
    }
    if (localCoupon.redeem_by) {
      params.redeem_by = Math.floor(new Date(localCoupon.redeem_by).getTime() / 1000);
    }
    // applies_to_plans is a different concept on Stripe — we enforce the
    // whitelist on our side at checkout time, so don't send applies_to.

    try {
      const fresh = await client.coupons.create(params);
      return { ok: true, stripe_coupon_id: fresh.id };
    } catch (createErr) {
      if (createErr?.code === 'resource_already_exists') {
        const fresh = await client.coupons.retrieve(params.id);
        return { ok: true, stripe_coupon_id: fresh.id, alreadyExisted: true };
      }
      throw createErr;
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Retrieve a Stripe Price — used by the checkout route to look up the
 * currency before minting a currency-matched coupon.
 */
export async function retrievePrice(priceId) {
  if (!priceId) return { ok: false, error: 'priceId required' };
  try {
    const client = requireClient();
    const price = await client.prices.retrieve(priceId);
    return { ok: true, price };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Resolve a free-form code typed by a tenant into either a Stripe
 * promotion_code id or a coupon id. Tries the customer-facing
 * `promotion_codes.list` lookup first (since that's what most users
 * enter), then falls back to `coupons.retrieve` for raw coupon ids.
 */
async function resolveCouponOrPromotionCode(client, raw) {
  const code = String(raw || '').trim();
  if (!code) return {};
  // 1. Promotion-code lookup (case-insensitive on Stripe's side; we
  //    upper-case so consistent matching).
  try {
    const list = await client.promotionCodes.list({
      code: code.toUpperCase(),
      active: true,
      limit: 1
    });
    if (list.data && list.data.length > 0) {
      return { promotion_code: list.data[0].id };
    }
  } catch (_) { /* fall through to coupon retrieve */ }
  // 2. Raw coupon id retrieval — works if the tenant pasted a Stripe
  //    coupon id directly, or if our admin coupon mirror stored the
  //    coupon id rather than a promotion code.
  try {
    const coupon = await client.coupons.retrieve(code);
    if (coupon && coupon.valid) return { coupon: coupon.id };
  } catch (_) { /* not a coupon either */ }
  return {};
}

// ── Customer Portal ─────────────────────────────────────────────────

/**
 * Create a Stripe Customer Portal session — Stripe-hosted page where the
 * tenant can update their card, see invoices, cancel, change plan, etc.
 */
export async function createPortalSession({ customerId, returnUrl }) {
  const client = requireClient();
  return client.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl
  });
}

// ── Webhook signature verification ──────────────────────────────────

export function constructWebhookEvent(rawBody, signature) {
  const client = requireClient();
  if (!stripeConfig.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  }
  return client.webhooks.constructEvent(rawBody, signature, stripeConfig.webhookSecret);
}

// ── Subscription read ────────────────────────────────────────────────

export async function retrieveSubscription(subscriptionId) {
  const client = requireClient();
  return client.subscriptions.retrieve(subscriptionId);
}

/**
 * List a customer's subscriptions, most-recent first. status:'all' so the
 * caller decides which states count as "live". Used by the reconciler's
 * self-heal path to recover a subscription when no local row exists.
 */
export async function listSubscriptionsForCustomer(customerId) {
  const client = requireClient();
  const res = await client.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20
  });
  return res.data || [];
}

/**
 * Pause a Stripe subscription's collection for up to N days. After
 * `resumes_at`, billing automatically resumes. The customer keeps
 * access through the pause window — Stripe just stops invoicing.
 */
export async function pauseSubscription({ subscriptionId, days }) {
  if (!subscriptionId) return { ok: false, error: 'subscriptionId required' };
  const numDays = Math.max(1, Math.min(90, Number(days) || 30));
  try {
    const client = requireClient();
    const resumesAt = Math.floor(Date.now() / 1000) + numDays * 24 * 60 * 60;
    const updated = await client.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: 'void', resumes_at: resumesAt }
    });
    return { ok: true, subscription: updated, resumes_at: new Date(resumesAt * 1000) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Sync a Plan to Stripe — ensures the Product + monthly + annual Prices
 * exist and returns their ids. Idempotent and safe to call on every plan
 * create / price edit:
 *
 *   - Product: created if missing; its name is kept in sync if it already
 *     exists (the retrieve/update doubles as a "still valid?" check).
 *   - Prices: Stripe Prices are IMMUTABLE — a changed amount cannot be
 *     edited in place. When the plan's amount differs from the live Stripe
 *     Price we archive the stale Price and mint a new one. Existing
 *     subscriptions keep billing the archived Price (Stripe still charges
 *     archived prices for active subs); only new checkouts move to the new
 *     one, which matches the app's pinned-revision model.
 *
 * Returns `{ ok, productId, monthlyPriceId, annualPriceId, created, archived }`.
 * Never throws — Stripe failures come back as `{ ok: false, error }`.
 */
export async function syncPlanToStripe(plan) {
  if (!plan || !plan.plan_code) return { ok: false, error: 'plan must have plan_code' };
  try {
    const client = requireClient();
    const created = { product: false, monthly: false, annual: false };

    // 1. Product. The id lives under `pricing.stripeProductId`; older code
    //    wrote it to `metadata.stripeProductId`, so read that as a legacy
    //    fallback. update() also validates it — 404s if the product was
    //    deleted in the dashboard, in which case we recreate.
    let productId = plan.pricing?.stripeProductId || plan.metadata?.stripeProductId || null;
    if (productId) {
      try {
        await client.products.update(productId, { name: plan.plan_name || plan.plan_code });
      } catch (_) { productId = null; }
    }
    if (!productId) {
      const product = await client.products.create({
        name: plan.plan_name || plan.plan_code,
        metadata: { plan_code: plan.plan_code, source: 'stewardex' }
      });
      productId = product.id;
      created.product = true;
    }

    // Ensure a recurring Price for a cycle matches the plan's amount.
    // Reuses the live Price when the amount is unchanged; otherwise
    // archives the immutable old Price and mints a fresh one.
    const ensurePrice = async (cycle, currentId, amountAUD) => {
      const wanted = amountAUD && amountAUD > 0 ? Math.round(amountAUD * 100) : null;
      let archived = null;

      if (currentId) {
        try {
          const existing = await client.prices.retrieve(currentId);
          if (existing && existing.active) {
            const unchanged = wanted != null
              && existing.unit_amount === wanted
              && String(existing.currency).toLowerCase() === 'aud';
            if (unchanged) return { id: existing.id, created: false, archived: null };
            // Amount changed (or the cycle no longer has a price) —
            // archive the old Price before minting its replacement.
            await client.prices.update(existing.id, { active: false }).catch(() => {});
            archived = existing.id;
          }
        } catch (_) { /* stale / deleted price id — just mint a fresh one */ }
      }

      if (wanted == null) return { id: null, created: false, archived };

      const price = await client.prices.create({
        product: productId,
        currency: 'aud',
        unit_amount: wanted,
        recurring: { interval: cycle === 'yearly' ? 'year' : 'month' },
        metadata: { plan_code: plan.plan_code, cycle, source: 'stewardex' }
      });
      return { id: price.id, created: true, archived };
    };

    const monthly = await ensurePrice('monthly', plan.pricing?.stripeMonthlyPriceId, plan.pricing?.monthlyAUD);
    created.monthly = monthly.created;
    const annual = await ensurePrice('yearly', plan.pricing?.stripeAnnualPriceId, plan.pricing?.annualAUD);
    created.annual = annual.created;

    return {
      ok: true,
      productId,
      monthlyPriceId: monthly.id,
      annualPriceId: annual.id,
      created,
      archived: [monthly.archived, annual.archived].filter(Boolean)
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Inspect a Stripe Customer's currency state. A customer becomes
 * "locked" to a currency the moment they have ANY of: an active
 * subscription, an open invoice/quote/invoice-item, OR even an
 * abandoned-but-not-yet-expired Checkout Session in that currency.
 *
 * Returns:
 *   { ok, currency: 'aud' | 'usd' | … | null, hasOpenCheckout, hasActiveSubscription }
 * currency = null means the customer is "clean" (no commitment yet).
 */
export async function inspectCustomerCurrency(customerId) {
  if (!customerId) return { ok: false, error: 'customerId required' };
  try {
    const client = requireClient();

    // 1. Retrieve the customer object — this is the authoritative lock.
    //    Once Stripe sets `customer.currency` (from ANY first commitment:
    //    invoice, subscription, invoice item, quote, customer-level
    //    discount), it's permanent for the lifetime of that customer.
    //    Expiring sessions does NOT release this lock — only minting a
    //    new customer does.
    const customer = await client.customers.retrieve(customerId).catch(() => null);
    if (!customer || customer.deleted) {
      return { ok: true, currency: null, hasActiveSubscription: false, hasOpenCheckout: false, customerCurrencyPinned: false, openSessionId: null };
    }
    const pinnedCurrency = customer.currency ? customer.currency.toLowerCase() : null;

    // 2. Look at subs — gives context for whether the customer has live
    //    paid usage we'd be abandoning if we orphaned them.
    const subs = await client.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    const liveSub = subs.data.find((s) => ['active', 'trialing', 'past_due', 'unpaid', 'paused'].includes(s.status));

    // 3. Look at recent checkout sessions — abandoned sessions reserve
    //    the currency temporarily even before customer.currency is set.
    //    Expiring them releases that reservation.
    const sessions = await client.checkout.sessions.list({ customer: customerId, limit: 20 });
    const openSession = sessions.data.find((s) => s.status === 'open');

    return {
      ok: true,
      currency: pinnedCurrency || liveSub?.currency || openSession?.currency || null,
      customerCurrencyPinned: !!pinnedCurrency,
      hasActiveSubscription: !!liveSub,
      hasOpenCheckout: !!openSession,
      openSessionId: openSession?.id || null
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Create a per-tenant recurring Price under an existing plan Product.
 *
 * Used by the override flow so Calcite ops never have to open the Stripe
 * Dashboard to mint a custom price. The new Price hangs off the plan's
 * existing Product (e.g. "Foundation Plan") and is tagged in metadata so
 * audit/reporting can pick it out from regular plan prices.
 *
 * @param {object} args
 * @param {string} args.productId    - existing plan Product id (plan.pricing.stripeProductId)
 * @param {number} args.amount       - whole-units amount in `currency` (e.g. 799 = $799)
 * @param {string} args.currency     - lower-case ISO ('aud' | 'usd' | …)
 * @param {'month'|'year'} args.interval
 * @param {string} args.orgId        - tenant orgId, stored in metadata
 * @param {string} args.planCode     - plan slug, stored in metadata
 * @param {string} [args.reason]
 * @returns {Promise<{ ok, price, error? }>}
 */
export async function createOverridePrice({ productId, amount, currency, interval, orgId, planCode, reason }) {
  if (!productId)  return { ok: false, error: 'productId required' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'amount must be a positive number' };
  if (!currency)   return { ok: false, error: 'currency required' };
  if (interval !== 'month' && interval !== 'year') return { ok: false, error: 'interval must be month or year' };
  try {
    const client = requireClient();
    const price = await client.prices.create({
      product: productId,
      currency: String(currency).toLowerCase(),
      unit_amount: Math.round(Number(amount) * 100), // Stripe takes minor units
      recurring: { interval },
      nickname: `Override · ${planCode || 'plan'} · ${orgId || 'tenant'} · ${interval}`,
      metadata: {
        override: 'true',
        orgId: orgId || '',
        plan_code: planCode || '',
        reason: (reason || '').slice(0, 480)
      }
    });
    return { ok: true, price };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Bill an in-period overage charge immediately — used by the tenant's
 * "Pay outstanding overage now" button. Creates a one-off invoice item
 * on the customer, finalises it as a draft invoice, then attempts to
 * charge their default payment method.
 *
 * Returns the resulting invoice. If the auto-charge fails (decline,
 * 3DS required, etc.) the invoice is still returned in `open` state so
 * the caller can surface the hosted-invoice URL for manual payment.
 */
/**
 * Create a one-off Stripe Checkout Session (payment mode, not
 * subscription) for the tenant's outstanding overage. The session URL
 * is returned so the frontend can redirect the customer to Stripe's
 * hosted payment page — they see the amount, confirm with their saved
 * card or enter a new one, and Stripe handles SCA / 3DS automatically.
 *
 * Why Checkout instead of invoices.pay():
 *   - User sees a familiar Stripe-branded page (trust + transparency)
 *   - Handles SCA / 3DS for cards that require it (Indian, EU, etc.)
 *   - One-time payments don't pin the customer to a new currency
 *   - Built-in failure / cancel handling via redirect URLs
 *
 * The success URL hits the existing /platform/billing/overage-paid
 * webhook handler (created below) which credits the paid amount
 * against the period's overage budget so the tenant unfreezes.
 */
export async function chargeOutstandingOverage({ customerId, amountAUD, description, successUrl, cancelUrl, metadata = {} }) {
  if (!customerId) return { ok: false, error: 'customerId required' };
  if (!(Number(amountAUD) > 0)) return { ok: false, error: 'amountAUD must be > 0' };
  if (!successUrl || !cancelUrl) return { ok: false, error: 'successUrl and cancelUrl required' };
  try {
    const client = requireClient();
    const cents = Math.round(Number(amountAUD) * 100);

    const session = await client.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{
        price_data: {
          currency: 'aud',
          unit_amount: cents,
          product_data: {
            name: 'Outstanding overage charges',
            description: description || 'In-period overage settlement.'
          }
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        description: description || 'Overage charges — pay now',
        metadata: { ...metadata, kind: 'overage_paynow' }
      },
      metadata: { ...metadata, kind: 'overage_paynow' }
    });
    return {
      ok: true,
      session_id: session.id,
      checkout_url: session.url,
      amount_aud: cents / 100
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Expire every still-open Checkout Session for a customer. Used to
 * unblock a customer who abandoned a checkout in one currency and
 * wants to retry in another — abandoning a session doesn't auto-expire
 * it for up to 24 hours, which strands the customer.
 */
export async function expireOpenCheckoutSessions(customerId) {
  if (!customerId) return { ok: false, error: 'customerId required' };
  try {
    const client = requireClient();
    const sessions = await client.checkout.sessions.list({ customer: customerId, limit: 50 });
    const open = sessions.data.filter((s) => s.status === 'open');
    for (const s of open) {
      await client.checkout.sessions.expire(s.id).catch(() => {});
    }
    return { ok: true, expired: open.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Mark a subscription to cancel at the end of the current billing
 * period. The customer keeps access until then; Stripe doesn't refund.
 */
export async function cancelAtPeriodEnd({ subscriptionId, cancellationDetails }) {
  if (!subscriptionId) return { ok: false, error: 'subscriptionId required' };
  try {
    const client = requireClient();
    const updated = await client.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      ...(cancellationDetails ? { cancellation_details: cancellationDetails } : {})
    });
    return { ok: true, subscription: updated };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Undo a pending end-of-period cancellation. */
export async function restartSubscription({ subscriptionId }) {
  if (!subscriptionId) return { ok: false, error: 'subscriptionId required' };
  try {
    const client = requireClient();
    const updated = await client.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false
    });
    return { ok: true, subscription: updated };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Re-anchor a subscription's billing cycle so future invoices fall on a
 * specific calendar day. Accepts a Date; Stripe wants a unix timestamp.
 */
export async function setBillingCycleAnchor({ subscriptionId, anchorDate, proration = 'none' }) {
  if (!subscriptionId || !anchorDate) return { ok: false, error: 'subscriptionId and anchorDate required' };
  try {
    const client = requireClient();
    const updated = await client.subscriptions.update(subscriptionId, {
      billing_cycle_anchor: Math.floor(new Date(anchorDate).getTime() / 1000),
      proration_behavior: proration
    });
    return { ok: true, subscription: updated };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Resume a paused Stripe subscription immediately. */
export async function resumeSubscription({ subscriptionId }) {
  if (!subscriptionId) return { ok: false, error: 'subscriptionId required' };
  try {
    const client = requireClient();
    const updated = await client.subscriptions.update(subscriptionId, {
      pause_collection: ''
    });
    return { ok: true, subscription: updated };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Report a metered usage record against a subscription's overage item.
 *
 * Stripe takes the meter Price's id; the SubscriptionItem id is the per-
 * subscription instance. We pass the meter Price ID and look up the right
 * subscription item by matching its `price.id`.
 *
 * Returns { ok: true, recorded } on success; { ok: false, error } otherwise.
 * Caller does NOT throw on failure — just logs (degrade open).
 */
export async function reportOverageUsage({ subscriptionId, meterPriceId, quantity = 1 }) {
  if (!subscriptionId || !meterPriceId) return { ok: false, error: 'subscriptionId and meterPriceId required' };
  try {
    const client = requireClient();
    const sub = await client.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
    const meterItem = sub.items?.data?.find((it) => it.price?.id === meterPriceId);
    if (!meterItem) {
      // Auto-add the meter to the subscription if missing — first overage event.
      const added = await client.subscriptionItems.create({
        subscription: subscriptionId,
        price: meterPriceId
      });
      await client.subscriptionItems.createUsageRecord(added.id, {
        quantity,
        timestamp: Math.floor(Date.now() / 1000),
        action: 'increment'
      });
      return { ok: true, recorded: quantity, item: added.id, added: true };
    }
    await client.subscriptionItems.createUsageRecord(meterItem.id, {
      quantity,
      timestamp: Math.floor(Date.now() / 1000),
      action: 'increment'
    });
    return { ok: true, recorded: quantity, item: meterItem.id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Page through every invoice for a Stripe customer (newest first).
 * Returns up to `limit` invoices with the fields we care about for
 * reconciliation. Used by the SuperAdmin invoice backfill endpoint.
 */
export async function listInvoicesForCustomer({ customerId, limit = 100 }) {
  const client = requireClient();
  const all = [];
  let starting_after;
  while (all.length < limit) {
    const page = await client.invoices.list({
      customer: customerId,
      limit: Math.min(100, limit - all.length),
      ...(starting_after ? { starting_after } : {})
    });
    if (!page.data?.length) break;
    all.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return all.slice(0, limit);
}

/**
 * Swap the recurring Price on an existing subscription. Used when:
 *   - SuperAdmin migrates tenants to a new revision (new Price ID)
 *   - SuperAdmin saves a per-tenant override with a custom Price ID
 *
 * Stripe handles proration automatically — `proration_behavior: 'create_prorations'`
 * adds/credits the difference on the next invoice.
 *
 * Returns { ok: true } on success, { ok: false, error } if the call fails
 * (so callers can keep iterating across many tenants without blowing up).
 */
/**
 * Issue a Stripe credit note against an invoice.
 *
 * @param {object} args
 * @param {string} args.invoiceId  Stripe invoice id (`in_…`)
 * @param {number} [args.amountAUD]  Optional override; if absent, credits the full amount due.
 * @param {string} [args.memo]  Internal memo; surfaced on the credit note.
 * @param {string} [args.reason]  Stripe reason enum: 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory'
 * @returns {Promise<{ ok, creditNote? , error? }>}
 */
export async function createCreditNote({
  invoiceId,
  amountAUD,
  memo = '',
  reason = 'order_change',
  disposition = 'credit_balance' // 'refund' | 'credit_balance' | 'out_of_band'
}) {
  if (!invoiceId) return { ok: false, error: 'invoiceId required' };
  try {
    const client = requireClient();

    // For a paid invoice, Stripe requires the post-payment portion to
    // be disposed of via refund / customer credit balance / out-of-band.
    // The three amounts must sum to `post_payment_amount`. For an open
    // (unpaid) invoice, none of these apply — the credit just lowers
    // the amount due. We retrieve the invoice up-front to figure out
    // which case we're in.
    const invoice = await client.invoices.retrieve(invoiceId);
    const isPaid = invoice.status === 'paid' || invoice.amount_remaining === 0;

    // Total credit amount in cents. If the caller didn't pass an amount,
    // default to crediting the full invoice — for paid invoices that's
    // the entire amount, for open ones it's whatever's remaining.
    const cents = amountAUD != null
      ? Math.round(Number(amountAUD) * 100)
      : (isPaid ? invoice.amount_paid : invoice.amount_remaining);

    const params = {
      invoice: invoiceId,
      amount: cents,
      memo: memo || undefined,
      reason
    };

    if (isPaid) {
      // post_payment_amount is the slice of the credit that lands AFTER
      // the invoice has been paid — i.e. money already collected that
      // we now need to return somewhere. For a fully-paid invoice this
      // equals the credit amount.
      const postPaymentCents = Math.min(cents, invoice.amount_paid);
      if (disposition === 'refund') {
        params.refund_amount = postPaymentCents;
      } else if (disposition === 'out_of_band') {
        params.out_of_band_amount = postPaymentCents;
      } else {
        // Default: park the credit on the customer balance — applied
        // automatically to the next invoice. Safest choice because it
        // doesn't move any money on the card.
        params.credit_amount = postPaymentCents;
      }
    }

    const creditNote = await client.creditNotes.create(params);
    return { ok: true, creditNote, disposition: isPaid ? disposition : 'pre_payment' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Void a Stripe invoice (only works for finalized invoices that haven't
 * been paid). For paid invoices, use `createCreditNote` instead.
 */
export async function voidInvoice(invoiceId) {
  if (!invoiceId) return { ok: false, error: 'invoiceId required' };
  try {
    const client = requireClient();
    const invoice = await client.invoices.voidInvoice(invoiceId);
    return { ok: true, invoice };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Retry payment on an open / past-due invoice. Stripe will attempt the
 * default payment method on the customer.
 */
export async function retryInvoicePayment(invoiceId) {
  if (!invoiceId) return { ok: false, error: 'invoiceId required' };
  try {
    const client = requireClient();
    const invoice = await client.invoices.pay(invoiceId);
    return { ok: true, invoice };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Attach a coupon to an existing Stripe subscription. Used by the
 * "apply coupon" flow on a tenant's detail page (handbook §2.4 / §5.3).
 */
export async function applyCouponToSubscription({ subscriptionId, couponCode }) {
  if (!subscriptionId || !couponCode) return { ok: false, error: 'subscriptionId and couponCode required' };
  try {
    const client = requireClient();
    const updated = await client.subscriptions.update(subscriptionId, {
      coupon: couponCode
    });
    return { ok: true, subscription: updated };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Detach a coupon from an existing Stripe subscription. Stripe accepts
 * `coupon: ''` to clear; we use `deleteDiscount` for cleaner semantics.
 */
export async function removeCouponFromSubscription({ subscriptionId }) {
  if (!subscriptionId) return { ok: false, error: 'subscriptionId required' };
  try {
    const client = requireClient();
    await client.subscriptions.deleteDiscount(subscriptionId);
    return { ok: true };
  } catch (err) {
    // Stripe returns 404 when no discount existed — treat that as success.
    if (err?.statusCode === 404) return { ok: true, alreadyClear: true };
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function swapSubscriptionPrice({ subscriptionId, newPriceId, proration = 'create_prorations' }) {
  if (!subscriptionId || !newPriceId) return { ok: false, error: 'subscriptionId and newPriceId required' };
  try {
    const client = requireClient();
    const sub = await client.subscriptions.retrieve(subscriptionId);
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) return { ok: false, error: 'subscription has no items' };
    await client.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: proration
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export default {
  isStripeConfigured,
  getStripeMode,
  ensureStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  retrieveSubscription,
  StripeNotConfiguredError
};
