/**
 * Stripe webhook handler.
 *
 * Public endpoint — no auth, but the signature header is verified against
 * STRIPE_WEBHOOK_SECRET. Mounted with raw body parsing because Stripe
 * signs the exact bytes of the payload (express.json() would mangle that).
 *
 * Events we care about:
 *   checkout.session.completed         → finalise OrganizationSubscription
 *   customer.subscription.created      → idempotent fallback for the same
 *   customer.subscription.updated      → status / period changes
 *   customer.subscription.deleted      → status='cancelled'
 *   invoice.paid                       → append Payment record
 *   invoice.payment_failed             → status='past_due', emit BillingEvent
 *
 * Every successful processing busts the tenant's entitlement cache so the
 * change is reflected on their next request.
 */

import express from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { constructWebhookEvent, retrieveSubscription, isStripeConfigured } from '../../services/stripeService.js';
import { applySubscriptionToTenant, inferBillingCycle } from '../../services/subscriptionReconciler.js';
import { invalidateEntitlements } from '../../services/entitlementService.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
import {
  sendSubscriptionWelcome,
  sendPastDueAlert,
  sendCancellationConfirmation,
  sendPaymentReceipt
} from '../../services/billingEmails.js';
import { getOrgOwnerEmail } from '../../utils/getOrgOwnerEmail.js';

const router = express.Router();

// Stripe webhook needs the raw body for signature verification — DON'T
// run express.json() on this route. The mount in app.js applies
// express.raw() before this router so req.body is a Buffer.
router.post('/', asyncHandler(async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).send('Stripe not configured.');
  }
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing stripe-signature header.');
  }

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err?.message || err);
    return res.status(400).send(`Signature verification failed: ${err?.message || err}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object, req);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object, req);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object, req);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object, req);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object, req);
        break;
      default:
        // Acknowledge unhandled events so Stripe doesn't retry forever.
        // Log them in case we want to handle later.
        console.log('[stripe webhook] unhandled event:', event.type);
    }
  } catch (err) {
    console.error('[stripe webhook] handler error for', event.type, ':', err?.message || err);
    // Return 500 so Stripe retries. If you'd rather not retry, return 200.
    return res.status(500).send('Handler error.');
  }

  res.status(200).json({ received: true });
}));

// ── Event handlers ──────────────────────────────────────────────────

async function handleCheckoutCompleted(session, req) {
  const orgId = session.metadata?.orgId || session.subscription_data?.metadata?.orgId;
  if (!orgId) {
    console.warn('[stripe webhook] checkout.session.completed without orgId metadata');
    return;
  }

  // Overage pay-now path. The session.mode is 'payment' (not subscription)
  // and metadata.kind tells us it's the in-period overage settlement
  // flow. Credit the paid amount against the period budget so the
  // tenant unfreezes; no subscription is touched.
  const kind = session.metadata?.kind || session.payment_intent?.metadata?.kind || '';
  if (kind === 'overage_paynow' || session.mode === 'payment') {
    const amountPaidCents = Number(session.amount_total) || 0;
    const amountPaidAud = amountPaidCents / 100;
    if (amountPaidAud > 0 && session.payment_status === 'paid') {
      const { OrganizationSubscription } = getRouterModels();
      const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
      if (sub) {
        sub.current_period_overage_paid_aud = (Number(sub.current_period_overage_paid_aud) || 0) + amountPaidAud;
        sub.current_period_overage_invoice_id = session.id || '';
        await sub.save();
      }
      // Audit row so support can see who paid when.
      const { BillingEvent } = getRouterModels();
      await BillingEvent.create({
        action: 'subscription.overage_paid_now',
        target_type: 'subscription',
        target_id: orgId,
        target_label: orgId,
        tenant_id: orgId,
        reason: `Overage settled via Stripe Checkout — A$${amountPaidAud.toFixed(2)}`,
        metadata: {
          amount_aud: amountPaidAud,
          stripe_session_id: session.id,
          stripe_customer_id: session.customer
        }
      }).catch(() => {});
      const { invalidateEntitlements } = await import('../../services/entitlementService.js');
      invalidateEntitlements(orgId);
    }
    return;
  }

  // The subscription is created at checkout completion — fetch it for full details.
  const subscriptionId = session.subscription;
  if (!subscriptionId) return;
  const stripeSub = await retrieveSubscription(subscriptionId);
  await applySubscriptionToTenant(orgId, stripeSub, { req, source: 'stripe_webhook' });

  // Welcome email — best-effort.
  const ownerEmail = await getOrgOwnerEmail(orgId).catch(() => null);
  if (ownerEmail) {
    const { SubscriptionPlan } = getRouterModels();
    const plan = await SubscriptionPlan.findById(stripeSub.items?.data?.[0]?.price?.product
      ? null
      : null).catch(() => null);
    const planName = stripeSub.metadata?.planCode
      ? (await getRouterModels().SubscriptionPlan.findOne({ plan_code: stripeSub.metadata.planCode }).lean())?.plan_name
      : (plan?.plan_name);
    const amountAUD = (stripeSub.items?.data?.[0]?.price?.unit_amount || 0) / 100;
    sendSubscriptionWelcome({
      to: ownerEmail,
      orgName: orgId,
      planName: planName || 'Stewardex',
      amountAUD,
      billingCycle: inferBillingCycle(stripeSub),
      periodEndAt: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : null,
      isTrial: stripeSub.status === 'trialing'
    });
  }
}

async function handleSubscriptionUpdated(stripeSub, req) {
  const orgId = stripeSub.metadata?.orgId;
  if (!orgId) {
    console.warn('[stripe webhook] subscription.updated without orgId metadata, sub:', stripeSub.id);
    return;
  }
  await applySubscriptionToTenant(orgId, stripeSub, { req, source: 'stripe_webhook' });
}

async function handleSubscriptionDeleted(stripeSub, req) {
  const orgId = stripeSub.metadata?.orgId;
  if (!orgId) return;
  const { OrganizationSubscription, SubscriptionPlan } = getRouterModels();
  const local = await OrganizationSubscription.findOne({ organization_id: orgId });
  if (!local) return;
  local.status = 'cancelled';
  local.cancelled_at = new Date();
  local.cancel_at_period_end = false;
  await local.save();
  invalidateEntitlements(orgId);
  await writeBillingEvent(req, {
    action: 'subscription.cancelled',
    targetType: 'subscription',
    targetId: orgId,
    targetLabel: orgId,
    tenantId: orgId,
    metadata: { stripe_subscription_id: stripeSub.id, source: 'stripe_webhook' }
  });

  // Cancellation confirmation email.
  const ownerEmail = await getOrgOwnerEmail(orgId).catch(() => null);
  if (ownerEmail) {
    const plan = await SubscriptionPlan.findById(local.plan_id).lean().catch(() => null);
    sendCancellationConfirmation({
      to: ownerEmail,
      orgName: orgId,
      planName: plan?.plan_name || 'your plan',
      periodEndAt: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : null
    });
  }
}

async function handleInvoicePaid(invoice, req) {
  const { Payment, OrganizationSubscription } = getRouterModels();
  const orgId = invoice.subscription_details?.metadata?.orgId
    || invoice.metadata?.orgId
    || (await orgIdFromCustomer(invoice.customer));
  if (!orgId) {
    console.warn('[stripe webhook] invoice.paid without resolvable orgId, invoice:', invoice.id);
    return;
  }
  // Record the Payment.
  await Payment.create({
    organization_id: orgId,
    stripe_payment_id: invoice.payment_intent || invoice.id,
    stripe_payment_intent_id: invoice.payment_intent || null,
    stripe_invoice_id: invoice.id,
    amount: (invoice.amount_paid || 0) / 100,
    currency: (invoice.currency || 'aud').toUpperCase(),
    status: 'succeeded',
    description: invoice.description || `Stripe invoice ${invoice.number || invoice.id}`,
    metadata: {
      hosted_invoice_url: invoice.hosted_invoice_url,
      invoice_pdf: invoice.invoice_pdf,
      invoice_number: invoice.number,
      stripe_subscription_id: invoice.subscription
    },
    payment_date: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : new Date()
  }).catch((err) => {
    // Idempotency: duplicate stripe_invoice_id should not throw.
    if (err?.code !== 11000) throw err;
  });

  // Refresh local subscription status off the latest payment.
  const local = await OrganizationSubscription.findOne({ organization_id: orgId });
  if (local && local.status === 'past_due') {
    local.status = 'active';
    await local.save();
    invalidateEntitlements(orgId);
  }

  // Payment receipt email — fires on every successful charge so the
  // tenant has a record of what was paid. Best-effort; failures don't
  // block the webhook (Stripe retries the webhook itself if we 500).
  try {
    const ownerEmail = await getOrgOwnerEmail(orgId).catch(() => null);
    if (ownerEmail && invoice.amount_paid > 0) {
      const { SubscriptionPlan } = getRouterModels();
      const plan = local?.plan_id
        ? await SubscriptionPlan.findById(local.plan_id).lean().catch(() => null)
        : null;
      sendPaymentReceipt({
        to: ownerEmail,
        orgName: orgId,
        planName: plan?.plan_name || 'your subscription',
        amountAUD: invoice.amount_paid / 100,
        currency: (invoice.currency || 'aud').toUpperCase(),
        invoiceNumber: invoice.number || null,
        invoiceUrl: invoice.hosted_invoice_url || null,
        invoicePdfUrl: invoice.invoice_pdf || null,
        billingCycle: local?.billing_cycle || null,
        periodEndAt: local?.current_period_end || (invoice.period_end ? new Date(invoice.period_end * 1000) : null),
        paidAt: invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : new Date()
      });
    }
  } catch (err) {
    console.error('[stripe webhook] payment receipt email failed:', err?.message || err);
  }

  // First-overage auto-credit (handbook §5.2). If this invoice contains
  // an overage line AND the tenant hasn't yet had their first-overage
  // credit, issue a credit note for the overage portion and flag them.
  if (local && !local.first_overage_credited) {
    const overageLines = (invoice.lines?.data || []).filter((line) => {
      // Stripe meter usage lines have a `price.recurring.usage_type === 'metered'`,
      // OR carry `metadata.kind = 'overage'` if we tagged them ourselves.
      const isMeterLine = line?.price?.recurring?.usage_type === 'metered';
      const taggedOverage = line?.metadata?.kind === 'overage';
      return (isMeterLine || taggedOverage) && (line.amount || 0) > 0;
    });
    const overageAmount = overageLines.reduce((sum, l) => sum + (l.amount || 0), 0);
    if (overageAmount > 0) {
      try {
        const { createCreditNote } = await import('../../services/stripeService.js');
        const credit = await createCreditNote({
          invoiceId: invoice.id,
          amountAUD: overageAmount / 100,
          memo: 'First-overage goodwill credit',
          reason: 'order_change'
        });
        if (credit.ok) {
          local.first_overage_credited = true;
          await local.save();
          await writeBillingEvent(req, {
            action: 'invoice.first_overage_credit',
            targetType: 'invoice',
            targetId: invoice.id,
            targetLabel: invoice.number || invoice.id,
            tenantId: orgId,
            reason: 'Automatic — first overage on subscription',
            metadata: {
              amount_aud: overageAmount / 100,
              credit_note_id: credit.creditNote?.id || null,
              line_count: overageLines.length
            }
          });
          console.log('[first-overage-credit] issued for', orgId, 'amount:', overageAmount / 100);
        } else {
          console.error('[first-overage-credit] Stripe rejected credit note:', credit.error);
        }
      } catch (err) {
        console.error('[first-overage-credit] error:', err?.message || err);
      }
    }
  }
}

async function handleInvoicePaymentFailed(invoice, req) {
  const orgId = invoice.subscription_details?.metadata?.orgId
    || invoice.metadata?.orgId
    || (await orgIdFromCustomer(invoice.customer));
  if (!orgId) return;
  const { OrganizationSubscription, SubscriptionPlan } = getRouterModels();
  const local = await OrganizationSubscription.findOne({ organization_id: orgId });
  if (!local) return;
  local.status = 'past_due';
  await local.save();
  invalidateEntitlements(orgId);
  await writeBillingEvent(req, {
    action: 'subscription.paused',
    targetType: 'subscription',
    targetId: orgId,
    targetLabel: orgId,
    tenantId: orgId,
    reason: 'Payment failed.',
    metadata: { stripe_invoice_id: invoice.id, attempt_count: invoice.attempt_count }
  });

  // Past-due alert email — must reach the org owner immediately.
  const ownerEmail = await getOrgOwnerEmail(orgId).catch(() => null);
  if (ownerEmail) {
    const plan = await SubscriptionPlan.findById(local.plan_id).lean().catch(() => null);
    sendPastDueAlert({
      to: ownerEmail,
      orgName: orgId,
      planName: plan?.plan_name || 'your plan',
      amountAUD: (invoice.amount_due || 0) / 100,
      attemptCount: invoice.attempt_count || 1
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────

// The subscription write-path — applySubscriptionToTenant and its
// plan/status/billing-cycle helpers — now lives in
// services/subscriptionReconciler.js so the webhook, the manual repair
// script (scripts/reconcileFromCheckout.js), and the entitlement
// self-heal path all share one implementation.

async function orgIdFromCustomer(customerId) {
  if (!customerId) return null;
  const { OrganizationSubscription } = getRouterModels();
  const found = await OrganizationSubscription.findOne({ stripe_customer_id: customerId }).lean();
  return found?.organization_id || null;
}

export default router;
