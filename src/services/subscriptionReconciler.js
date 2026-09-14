/**
 * Subscription reconciler — the single source of truth for turning a
 * Stripe subscription into a local OrganizationSubscription row.
 *
 * Extracted from the Stripe webhook so the same write-path is reused by:
 *   - the webhook            (checkout.session.completed, subscription.*)
 *   - scripts/reconcileFromCheckout.js  (manual repair from a session id)
 *   - entitlementService.js  (self-heal on read when a webhook was missed)
 *
 * Why this exists: a missed or misconfigured webhook used to strand a
 * paid tenant with no local subscription indefinitely. These helpers let
 * any code path recover the subscription from Stripe's own state.
 */

import getRouterModels from '../db/models/routerModels.js';
import {
  retrieveSubscription,
  retrieveCheckoutSession,
  findStripeCustomerByOrgId,
  listSubscriptionsForCustomer,
} from './stripeService.js';
import { invalidateEntitlements } from './entitlementService.js';
import { writeBillingEvent } from '../utils/writeBillingEvent.js';

// Stripe statuses that mean "this subscription should grant access" —
// used when a customer has several subscriptions and we must pick one.
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

export function stripeStatusToLocal(stripeStatus) {
  switch (stripeStatus) {
    case 'active':              return 'active';
    case 'trialing':            return 'trialing';
    case 'past_due':            return 'past_due';
    case 'unpaid':              return 'past_due';
    case 'canceled':            return 'cancelled';
    case 'incomplete':          return 'incomplete';
    case 'incomplete_expired':  return 'cancelled';
    default:                    return stripeStatus;
  }
}

export function inferBillingCycle(stripeSub) {
  const item = stripeSub.items?.data?.[0];
  const interval = item?.price?.recurring?.interval;
  if (interval === 'year') return 'yearly';
  return 'monthly';
}

async function guessPlanFromPrice(stripeSub) {
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  const { SubscriptionPlan } = getRouterModels();
  const plan = await SubscriptionPlan.findOne({
    $or: [
      { 'pricing.stripeMonthlyPriceId': priceId },
      { 'pricing.stripeAnnualPriceId': priceId }
    ]
  }).lean();
  return plan?.plan_code || null;
}

/**
 * Take a Stripe subscription and write its state into our local
 * OrganizationSubscription. Pinned plan_revision_id stays unchanged on
 * updates (we don't auto-migrate revisions on Stripe events).
 *
 * `req` is optional — only used to attribute the BillingEvent actor, so
 * script / self-heal callers can omit it. Returns
 * { ok, action, status } or { ok: false, reason }.
 */
export async function applySubscriptionToTenant(orgId, stripeSub, { req = null, source = 'reconcile' } = {}) {
  const { OrganizationSubscription, SubscriptionPlan, PlanRevision } = getRouterModels();
  const planCode = stripeSub.metadata?.planCode || (await guessPlanFromPrice(stripeSub));
  if (!planCode) {
    console.warn('[reconcile] cannot resolve plan_code for subscription', stripeSub.id);
    return { ok: false, reason: 'plan_code_unresolved' };
  }
  const plan = await SubscriptionPlan.findOne({ plan_code: String(planCode).toLowerCase() });
  if (!plan) return { ok: false, reason: 'plan_not_found' };

  const billingCycle = inferBillingCycle(stripeSub);
  const status = stripeStatusToLocal(stripeSub.status);

  let local = await OrganizationSubscription.findOne({ organization_id: orgId });
  let action = 'subscription.assigned';
  if (local) {
    action = 'subscription.changed';
    if (String(local.plan_id) !== String(plan._id)) {
      // Plan changed in Stripe (upgrade/downgrade) — re-pin to that plan's latest revision.
      const latestRev = await PlanRevision.findOne({ plan_id: plan._id }).sort({ revision_number: -1 }).lean();
      local.plan_id = plan._id;
      local.plan_revision_id = latestRev?._id || null;
      local.plan_revision_number = latestRev?.revision_number || null;
    }
    local.billing_cycle = billingCycle;
    local.status = status;
    local.stripe_subscription_id = stripeSub.id;
    local.stripe_customer_id = stripeSub.customer;
    local.current_period_start = stripeSub.current_period_start ? new Date(stripeSub.current_period_start * 1000) : new Date();
    local.current_period_end = stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : new Date();
    local.cancel_at_period_end = !!stripeSub.cancel_at_period_end;
    await local.save();
  } else {
    const latestRev = await PlanRevision.findOne({ plan_id: plan._id }).sort({ revision_number: -1 }).lean();
    local = await OrganizationSubscription.create({
      organization_id: orgId,
      plan_id: plan._id,
      plan_revision_id: latestRev?._id || null,
      plan_revision_number: latestRev?.revision_number || null,
      billing_cycle: billingCycle,
      status,
      stripe_subscription_id: stripeSub.id,
      stripe_customer_id: stripeSub.customer,
      current_period_start: stripeSub.current_period_start ? new Date(stripeSub.current_period_start * 1000) : new Date(),
      current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : new Date(),
      cancel_at_period_end: !!stripeSub.cancel_at_period_end
    });
  }

  invalidateEntitlements(orgId);

  await writeBillingEvent(req, {
    action,
    targetType: 'subscription',
    targetId: orgId,
    targetLabel: orgId,
    tenantId: orgId,
    metadata: {
      stripe_subscription_id: stripeSub.id,
      plan_code: plan.plan_code,
      billing_cycle: billingCycle,
      status,
      source
    }
  });

  return { ok: true, action, status };
}

/**
 * Replay what the checkout.session.completed webhook would have done,
 * given just a Checkout Session id. Powers scripts/reconcileFromCheckout.js
 * for repairing a tenant whose webhook delivery was missed.
 */
export async function reconcileFromCheckoutSession(sessionId) {
  const session = await retrieveCheckoutSession(sessionId);
  if (!session) return { ok: false, reason: 'session_not_found' };

  const orgId = session.metadata?.orgId;
  if (!orgId) return { ok: false, reason: 'no_orgid_metadata' };

  if (session.mode !== 'subscription') {
    // 'payment' mode is the overage pay-now flow — not a subscription to
    // reconcile. Caller should report this rather than silently no-op.
    return { ok: false, reason: `unsupported_mode:${session.mode}`, orgId };
  }
  if (session.status !== 'complete' && session.payment_status !== 'paid') {
    return { ok: false, reason: `session_not_complete:${session.status}/${session.payment_status}`, orgId };
  }

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  if (!subscriptionId) return { ok: false, reason: 'no_subscription_on_session', orgId };

  const stripeSub = await retrieveSubscription(subscriptionId);
  const result = await applySubscriptionToTenant(orgId, stripeSub, { source: 'manual_script' });
  return { ...result, orgId, subscriptionId };
}

/**
 * Self-heal path: a tenant has no local OrganizationSubscription but may
 * actually have paid (webhook missed / misconfigured). Look the tenant up
 * in Stripe by orgId metadata and, if they have a live subscription,
 * write it locally. Returns { ok: true, ... } ONLY when a row was written.
 *
 * Read-only against Stripe until the moment it writes, and safe to call
 * on tenants who genuinely never subscribed — it just returns
 * { ok: false } after a couple of lookups.
 */
export async function reconcileFromStripeCustomer(orgId) {
  const customer = await findStripeCustomerByOrgId(orgId);
  if (!customer) return { ok: false, reason: 'no_stripe_customer' };

  const subs = await listSubscriptionsForCustomer(customer.id);
  // listSubscriptionsForCustomer returns most-recent first; pick the most
  // recent subscription in an access-granting state.
  const chosen = subs.find((s) => LIVE_STATUSES.includes(s.status)) || null;
  if (!chosen) return { ok: false, reason: 'no_live_subscription' };

  const result = await applySubscriptionToTenant(orgId, chosen, { source: 'entitlement_self_heal' });
  return { ...result, orgId, subscriptionId: chosen.id };
}
