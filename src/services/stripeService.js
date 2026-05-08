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
  try {
    const search = await client.customers.search({
      query: `metadata['orgId']:'${orgId}'`,
      limit: 1
    });
    if (search.data.length > 0) return search.data[0];
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

  return client.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: !couponCode, // tenant can paste a code if we didn't pre-apply one
    ...(couponCode ? { discounts: [{ coupon: couponCode }] } : {}),
    subscription_data: {
      metadata: { orgId, planCode, billingCycle },
      ...(trialDays && trialDays > 0 ? { trial_period_days: trialDays } : {})
    },
    metadata: { orgId, planCode, billingCycle }
  });
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
