/**
 * MarketplacePublicPurchase (Router DB) — anonymous (no-account)
 * purchases from the public-facing policy marketplace on the
 * marketing site.
 *
 * Differs from MarketplacePurchase in that there's no org_id (the
 * buyer might not be a Stewardex tenant). Instead, we identify the
 * buyer by:
 *   • email          — given at Stripe Checkout
 *   • claim_token    — opaque random string baked into the
 *                      success_url; the post-payment claim form
 *                      authenticates against this
 *
 * Lifecycle:
 *   pending   — Checkout Session created, payment not confirmed
 *   paid      — webhook (or reconcile-claim) flipped to paid
 *   claimed   — buyer entered org_name + logo on the claim page; we
 *               watermarked the PDF and stored its key for re-download
 *   refunded  — Stripe refund (future)
 */

import mongoose from 'mongoose';

const marketplacePublicPurchaseSchema = new mongoose.Schema({
  policy_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MarketplacePolicy',
    required: true,
    index: true
  },

  // Buyer identification — populated at Stripe Checkout.
  buyer_email: { type: String, default: '', lowercase: true, trim: true, index: true },
  // Opaque random token bound to the Checkout Session. The buyer
  // can only claim the policy if they hold this token (sent back
  // via the success_url and used to look this row up).
  claim_token: { type: String, required: true, unique: true, index: true },

  // Price snapshot — what the buyer paid.
  amount_paid_cents: { type: Number, required: true, min: 0 },
  currency:          { type: String, default: 'aud', lowercase: true, trim: true },

  // Stripe linkage.
  stripe_session_id:        { type: String, default: '', index: true },
  stripe_payment_intent_id: { type: String, default: '' },
  stripe_customer_id:       { type: String, default: '' },

  status: {
    type: String,
    enum: ['pending', 'paid', 'claimed', 'refunded'],
    default: 'pending',
    index: true
  },

  // Snapshot for the buyer's confirmation email.
  policy_title_snapshot: { type: String, default: '' },
  policy_version_snapshot: { type: Number, default: 1 },

  // Branding the buyer entered at claim time.
  buyer_org_name: { type: String, default: '' },

  // S3 key of the file produced at claim time (watermarked PDF or
  // branded editable .docx). Empty until the buyer completes the claim.
  delivered_s3_key: { type: String, default: '' },
  delivered_file_name: { type: String, default: '' },
  // Which format the buyer chose on the claim page — 'pdf' (watermarked,
  // locked-down) or 'docx' (branded but editable, for tweaking before
  // an approval workflow).
  delivered_format: { type: String, enum: ['pdf', 'docx'], default: 'pdf' },

  // Atomic-claim lock for parallel webhook + reconcile delivery
  // attempts (same pattern as MarketplacePurchase.delivery_status).
  delivery_status: {
    type: String,
    enum: ['pending', 'in_progress', 'delivered', 'failed'],
    default: 'pending'
  },
  delivery_error: { type: String, default: '' },

  paid_at:      { type: Date, default: null },
  claimed_at:   { type: Date, default: null },
  created_at:   { type: Date, default: Date.now },
  updated_at:   { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'marketplace_public_purchases'
});

// Stripe session ids are unique on Stripe's side; mirror that here
// so duplicate webhook deliveries can't mint two rows.
marketplacePublicPurchaseSchema.index(
  { stripe_session_id: 1 },
  {
    unique: true,
    partialFilterExpression: { stripe_session_id: { $type: 'string', $gt: '' } },
    name: 'uniq_public_stripe_session_id'
  }
);

export default marketplacePublicPurchaseSchema;
