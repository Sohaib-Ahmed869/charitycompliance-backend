/**
 * MarketplacePurchase (Router DB) — one row per (orgId, policy_id, paid).
 *
 * Created by the Stripe webhook on checkout.session.completed when the
 * session metadata.kind === 'marketplace_policy'. We persist enough
 * detail to:
 *   • answer "did this org buy this policy?" without hitting Stripe
 *   • show the org their purchase history (with amount + when)
 *   • reconcile against Stripe if disputes / refunds happen later
 *
 * Idempotency: unique compound index on (org_id, policy_id, status='paid')
 * via a partial filter — re-running the webhook never creates duplicates.
 * stripe_session_id is also unique on its own (when present) for the
 * same reason from the other direction.
 */

import mongoose from 'mongoose';

const marketplacePurchaseSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  policy_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MarketplacePolicy',
    required: true,
    index: true
  },
  // Cached price snapshot — what the tenant paid. Decoupled from the
  // live MarketplacePolicy.price_aud_cents so future price changes
  // don't rewrite history.
  amount_paid_cents: { type: Number, required: true, min: 0 },
  currency:          { type: String, default: 'aud', lowercase: true, trim: true },

  // Stripe linkage. session_id is present from the moment we create
  // the checkout session; payment_intent_id arrives via webhook.
  stripe_session_id:        { type: String, default: '', index: true },
  stripe_payment_intent_id: { type: String, default: '' },
  stripe_customer_id:       { type: String, default: '' },

  // pending = checkout session created but not yet completed
  // paid    = webhook confirmed payment
  // refunded= refund processed (Phase 4+)
  status: {
    type: String,
    enum: ['pending', 'paid', 'refunded'],
    default: 'pending',
    index: true
  },

  // Convenience snapshot for the org's purchase list — saves a join
  // when rendering "you bought X policies".
  policy_title_snapshot: { type: String, default: '' },
  policy_version_snapshot: { type: Number, default: 1 },

  // After a successful payment we copy the marketplace PDF (watermarked
  // with the org's own logo) into the tenant's local policy library.
  // The resulting tenant Policy._id is stored here so the frontend can
  // deep-link the "Open policy" button.
  delivered_policy_id: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  // 'pending'     = paid but not yet copied to tenant
  // 'in_progress' = atomic claim taken by a delivery worker; prevents
  //                 webhook + reconcile-checkout from running twice in
  //                 parallel and minting two Policy rows
  // 'delivered'   = tenant Policy row created
  // 'failed'      = delivery error (we still let the user re-trigger)
  delivery_status: {
    type: String,
    enum: ['pending', 'in_progress', 'delivered', 'failed'],
    default: 'pending'
  },
  delivery_error: { type: String, default: '' },
  // True when the tenant has no approval workflow configured for
  // policies. The delivered Policy is saved as `draft` instead of
  // entering review; the frontend surfaces a "create a workflow to
  // publish" message until the buyer sets one up.
  workflow_pending: { type: Boolean, default: false },

  // True once the purchase confirmation / receipt email (with the
  // invoice PDF attached) has been sent. Guards against the webhook
  // and the reconcile-checkout fallback both emailing the same buyer
  // — the Payment row is deduped by a unique index, but the email is
  // not, so we gate it on this flag.
  receipt_sent: { type: Boolean, default: false },

  purchased_at: { type: Date, default: null },
  created_at:   { type: Date, default: Date.now },
  updated_at:   { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'marketplace_purchases'
});

// Idempotency: one paid row per (org_id, policy_id). pending rows can
// stack while the tenant retries Checkout — only the paid row matters.
marketplacePurchaseSchema.index(
  { org_id: 1, policy_id: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'paid' },
    name: 'uniq_paid_per_org_policy'
  }
);

// Stripe session ids are already unique within Stripe; mirror that in
// our store. Empty-string sessions aren't enforced (only real ids).
marketplacePurchaseSchema.index(
  { stripe_session_id: 1 },
  {
    unique: true,
    partialFilterExpression: { stripe_session_id: { $type: 'string', $gt: '' } },
    name: 'uniq_stripe_session_id'
  }
);

export default marketplacePurchaseSchema;
