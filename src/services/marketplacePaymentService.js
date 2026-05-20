/**
 * marketplacePaymentService — bridge a paid Policy Marketplace purchase
 * into the platform's billing surfaces.
 *
 * Marketplace purchases are recorded in their own Router DB collection
 * (`marketplace_purchases`). The SuperAdmin Invoices browser, however,
 * reads the shared `payments` collection — which is only ever appended
 * by the Stripe `invoice.paid` webhook (subscription billing). One-off
 * `payment`-mode Checkout sessions never generate a Stripe hosted
 * invoice, so a marketplace purchase used to leave no trace there.
 *
 * This service closes that gap:
 *   1. recordMarketplacePayment — upsert a Payment row so the purchase
 *      shows up in /admin/invoices alongside subscription invoices.
 *   2. sendMarketplaceReceipt   — generate an invoice PDF and email it
 *      to the org owner as the purchase confirmation / receipt.
 *
 * Both are idempotent and best-effort: the marketplace purchase itself
 * has already succeeded by the time we run, so a failure here is logged
 * but never thrown back to the webhook / reconcile caller.
 */

import getRouterModels from '../db/models/routerModels.js';
import { getOrgOwnerEmail } from '../utils/getOrgOwnerEmail.js';
import { generateMarketplaceInvoicePdf, marketplaceInvoiceNumber } from './marketplaceInvoicePdfService.js';
import { sendMarketplacePurchaseReceipt } from './billingEmails.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * Resolve the buyer org's display name from its tenant DB. Falls back
 * to the orgId on any failure — never throws.
 */
async function resolveOrgName(orgId) {
  if (!orgId) return '';
  try {
    const { getTenantConnection } = await import('../db/connectionManager.js');
    const tenantDb = await getTenantConnection(String(orgId).toLowerCase());
    const org = await tenantDb?.collection?.('organizations')?.findOne(
      {},
      { projection: { name: 1, legal_name: 1, trading_name: 1 } }
    );
    return org?.name || org?.legal_name || org?.trading_name || orgId;
  } catch (err) {
    logError('[marketplacePayment] org name lookup failed for', orgId, err?.message || err);
    return orgId;
  }
}

/**
 * recordMarketplacePayment — append a Payment row for a paid marketplace
 * purchase so it appears in the SuperAdmin Invoices list.
 *
 * Idempotent via the unique `stripe_payment_id` index — re-running on
 * an already-recorded purchase is a no-op (duplicate-key swallowed).
 *
 * @param {object} purchase — a (lean or hydrated) MarketplacePurchase doc
 * @returns {Promise<void>}
 */
export async function recordMarketplacePayment(purchase) {
  if (!purchase || purchase.status !== 'paid') return;
  try {
    const { Payment } = getRouterModels();

    // Prefer the payment intent as the dedupe key; fall back to the
    // session id, then a synthesised id so we never lose the row.
    const stripePaymentId =
      purchase.stripe_payment_intent_id ||
      purchase.stripe_session_id ||
      `marketplace_${purchase._id}`;

    const policyTitle = purchase.policy_title_snapshot || 'Policy template';
    const invoiceNumber = marketplaceInvoiceNumber(purchase._id);

    await Payment.create({
      organization_id: String(purchase.org_id).toLowerCase(),
      stripe_payment_id: stripePaymentId,
      stripe_payment_intent_id: purchase.stripe_payment_intent_id || null,
      // Intentionally NO stripe_invoice_id — marketplace purchases have
      // no Stripe hosted invoice. Leaving it unset keeps the credit /
      // void / retry actions (which require a Stripe invoice) disabled,
      // which is correct for a one-off charge.
      amount: (Number(purchase.amount_paid_cents) || 0) / 100,
      currency: String(purchase.currency || 'aud').toUpperCase(),
      status: 'succeeded',
      description: `Policy Marketplace — ${policyTitle}`,
      metadata: {
        kind: 'marketplace_policy',
        invoice_number: invoiceNumber,
        policy_id: String(purchase.policy_id || ''),
        policy_title: policyTitle,
        marketplace_purchase_id: String(purchase._id),
        stripe_session_id: purchase.stripe_session_id || ''
      },
      payment_date: purchase.purchased_at || new Date()
    });
    logInfo(`[marketplacePayment] Payment row recorded for purchase ${purchase._id}`);
  } catch (err) {
    if (err?.code === 11000) {
      // Already recorded — idempotent no-op.
      return;
    }
    logError('[marketplacePayment] recordMarketplacePayment failed:', err?.message || err);
  }
}

/**
 * sendMarketplaceReceipt — generate an invoice PDF for a marketplace
 * purchase and email it to the org owner as their receipt.
 *
 * Best-effort: a missing org owner email skips the send; a PDF-build
 * failure still sends the receipt body without the attachment.
 *
 * @param {object} purchase — a (lean or hydrated) MarketplacePurchase doc
 * @returns {Promise<void>}
 */
export async function sendMarketplaceReceipt(purchase) {
  if (!purchase || purchase.status !== 'paid') return;
  try {
    const { MarketplacePurchase } = getRouterModels();

    // Atomically claim the receipt send. The webhook and the
    // reconcile-checkout fallback can both reach this for the same
    // purchase; only the call that flips receipt_sent false→true
    // actually emails. Any other call gets null here and backs off.
    const claimed = await MarketplacePurchase.findOneAndUpdate(
      { _id: purchase._id, status: 'paid', receipt_sent: { $ne: true } },
      { $set: { receipt_sent: true } },
      { new: true }
    );
    if (!claimed) {
      logInfo(`[marketplacePayment] receipt already sent for purchase ${purchase._id} — skipped`);
      return;
    }

    const orgId = String(purchase.org_id).toLowerCase();
    const to = await getOrgOwnerEmail(orgId).catch(() => null);
    if (!to) {
      logInfo(`[marketplacePayment] no org owner email for ${orgId} — receipt skipped`);
      // Roll back the claim so a later retry (e.g. once an owner is
      // set) can still send the receipt.
      await MarketplacePurchase.updateOne(
        { _id: purchase._id },
        { $set: { receipt_sent: false } }
      ).catch(() => {});
      return;
    }

    const orgName = await resolveOrgName(orgId);
    const policyTitle = purchase.policy_title_snapshot || 'Policy template';
    const invoiceNumber = marketplaceInvoiceNumber(purchase._id);
    const currency = String(purchase.currency || 'aud').toUpperCase();
    const amountCents = Number(purchase.amount_paid_cents) || 0;
    const purchasedAt = purchase.purchased_at || new Date();

    let invoicePdfBuffer = null;
    try {
      invoicePdfBuffer = await generateMarketplaceInvoicePdf({
        invoiceNumber,
        orgName,
        orgId,
        policyTitle,
        policyVersion: purchase.policy_version_snapshot || 1,
        amountCents,
        currency,
        purchasedAt,
        stripeReceiptRef: purchase.stripe_payment_intent_id || purchase.stripe_session_id || ''
      });
    } catch (err) {
      logError('[marketplacePayment] invoice PDF generation failed:', err?.message || err);
    }

    await sendMarketplacePurchaseReceipt({
      to,
      orgName,
      policyTitle,
      amountAUD: amountCents / 100,
      currency,
      invoiceNumber,
      purchasedAt,
      invoicePdfBuffer
    });
    logInfo(`[marketplacePayment] receipt email dispatched for purchase ${purchase._id}`);
  } catch (err) {
    logError('[marketplacePayment] sendMarketplaceReceipt failed:', err?.message || err);
  }
}

/**
 * finaliseMarketplacePurchase — convenience wrapper that records the
 * Payment row and sends the receipt for a paid purchase. Both steps
 * are independent and best-effort.
 */
export async function finaliseMarketplacePurchase(purchase) {
  await recordMarketplacePayment(purchase);
  await sendMarketplaceReceipt(purchase);
}

export default {
  recordMarketplacePayment,
  sendMarketplaceReceipt,
  finaliseMarketplacePurchase
};
