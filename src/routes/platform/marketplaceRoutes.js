/**
 * Tenant-side Policy Marketplace endpoints.
 *
 *   GET  /platform/marketplace/groups              — active groups
 *   GET  /platform/marketplace/policies            — published policies (+purchased flag)
 *   GET  /platform/marketplace/policies/:id        — single policy with purchase status
 *   GET  /platform/marketplace/policies/:id/preview-stream
 *                                                  — stream the PDF bytes
 *                                                    for in-browser PDF.js preview
 *   POST /platform/marketplace/policies/:id/checkout
 *                                                  — Stripe Checkout (one-off
 *                                                    payment) — returns the
 *                                                    hosted checkout URL
 *   GET  /platform/marketplace/purchases           — purchases by this org
 *
 * Every endpoint runs behind authAndResolveTenant so we know the orgId.
 * Catalogue data lives in the Router DB; we never write to the tenant DB
 * from this surface (Phase 4 may copy purchased policies into the
 * tenant's local Policy collection — out of scope here).
 *
 * Pricing: MarketplacePolicy.price_aud_cents is already in Stripe's
 * minor-units format. We pass it straight into `unit_amount` without
 * any conversion math — that's how we avoid the round-tripping bugs
 * that plagued the donor refund flow.
 */

import express from 'express';
import { param, query, body } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler, AppError } from '../../middleware/errorHandler.js';
import { getFileStream, uploadToS3 } from '../../services/s3Service.js';
import { ensureStripeCustomer } from '../../services/stripeService.js';
import getRouterModels from '../../db/models/routerModels.js';
import serverConfig from '../../config/index.js';

const router = express.Router();
router.use(authAndResolveTenant);

// ── helpers ─────────────────────────────────────────────────────────

function serializeGroupForTenant(g) {
  return {
    id: g._id?.toString(),
    name: g.name,
    slug: g.slug,
    description: g.description || '',
    sort_order: g.sort_order ?? 100,
    accent_color: g.accent_color || ''
  };
}

function serializePolicyForTenant(p, purchased = false) {
  return {
    id: p._id?.toString(),
    group_id: p.group_id?.toString(),
    title: p.title,
    summary: p.summary || '',
    description: p.description || '',
    price_aud_cents: p.price_aud_cents ?? 0,
    price_aud: ((p.price_aud_cents ?? 0) / 100),
    file: {
      format: p.file?.format || 'pdf',
      bytes: p.file?.bytes || 0,
      original_name: p.file?.original_name || ''
    },
    tags: p.tags || [],
    version: p.version ?? 1,
    purchased,
    created_at: p.created_at
  };
}

// ── Groups ──────────────────────────────────────────────────────────

router.get('/groups', asyncHandler(async (req, res) => {
  const { MarketplacePolicyGroup, MarketplacePolicy } = getRouterModels();
  const groups = await MarketplacePolicyGroup
    .find({ status: 'active' })
    .sort({ sort_order: 1, created_at: -1 })
    .lean();

  // Per-group published count — saves the frontend an N+1 fetch.
  const ids = groups.map((g) => g._id);
  const counts = ids.length
    ? await MarketplacePolicy.aggregate([
        { $match: { group_id: { $in: ids }, status: 'published' } },
        { $group: { _id: '$group_id', n: { $sum: 1 } } }
      ])
    : [];
  const countMap = Object.fromEntries(counts.map((row) => [row._id.toString(), row.n]));

  res.json({
    success: true,
    data: groups.map((g) => ({
      ...serializeGroupForTenant(g),
      policy_count: countMap[g._id.toString()] || 0
    }))
  });
}));

// ── Policies ────────────────────────────────────────────────────────

router.get(
  '/policies',
  [
    query('group').optional().isMongoId(),
    query('search').optional().isString().trim().isLength({ max: 200 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy, MarketplacePurchase } = getRouterModels();
    const filter = { status: 'published' };
    if (req.query.group)  filter.group_id = req.query.group;
    if (req.query.search) filter.title = { $regex: req.query.search, $options: 'i' };

    const policies = await MarketplacePolicy
      .find(filter)
      .sort({ created_at: -1 })
      .lean();

    // Find all paid purchases this org has for the policies on the page.
    const ids = policies.map((p) => p._id);
    const paid = ids.length
      ? await MarketplacePurchase
          .find({ org_id: req.orgId, policy_id: { $in: ids }, status: 'paid' })
          .select('policy_id')
          .lean()
      : [];
    const paidSet = new Set(paid.map((r) => r.policy_id.toString()));

    res.json({
      success: true,
      data: policies.map((p) => serializePolicyForTenant(p, paidSet.has(p._id.toString())))
    });
  })
);

router.get(
  '/policies/:id',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy, MarketplacePurchase } = getRouterModels();
    const policy = await MarketplacePolicy.findOne({ _id: req.params.id, status: 'published' }).lean();
    if (!policy) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');

    const purchase = await MarketplacePurchase.findOne({
      org_id: req.orgId,
      policy_id: policy._id,
      status: 'paid'
    }).lean();

    res.json({
      success: true,
      data: {
        ...serializePolicyForTenant(policy, !!purchase),
        purchased_at: purchase?.purchased_at || null,
        amount_paid_cents: purchase?.amount_paid_cents || null,
        delivered_policy_id: purchase?.delivered_policy_id?.toString() || null,
        delivery_status: purchase?.delivery_status || null
      }
    });
  })
);

// ── Preview stream — PDF bytes for in-browser PDF.js rendering ──────
// We deliberately don't return an S3 presigned URL. Streaming through
// our backend (a) keeps the S3 keys private, (b) lets us add per-page
// auth checks later, and (c) lets us swap in pdf-lib server-side
// watermarking down the road without churning the frontend.

router.get(
  '/policies/:id/preview-stream',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy, MarketplacePurchase } = getRouterModels();
    const policy = await MarketplacePolicy.findOne({ _id: req.params.id, status: 'published' });
    if (!policy) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');

    const purchase = await MarketplacePurchase.findOne({
      org_id: req.orgId,
      policy_id: policy._id,
      status: 'paid'
    }).lean();

    // ── Resolve the S3 key to stream ─────────────────────────────
    // PDF policies stream the source file directly.
    // DOCX policies stream a cached pdf_preview_key. If the policy
    // pre-dates the converter (or the cached PDF was deleted) we
    // convert on-the-fly, cache the result on S3 and update the
    // policy doc so the next tenant gets the cached copy.
    let s3Key = policy.file?.pdf_preview_key || policy.file?.s3_key;

    if (policy.file?.format === 'docx') {
      if (!policy.file?.pdf_preview_key) {
        // Lazy conversion. Pulls the DOCX from S3, runs it through
        // mammoth + Puppeteer, uploads the result back to S3 and
        // stamps the policy with the new key. Synchronous so the
        // tenant gets their preview on the same request — adds a
        // few seconds on the first view per template.
        const sourceKey = policy.file?.s3_key;
        if (!sourceKey) throw new AppError('Policy has no file attached', 404, 'FILE_MISSING');
        try {
          const srcStream = await getFileStream(sourceKey);
          const docxBuf = await new Promise((resolve, reject) => {
            const chunks = [];
            srcStream.Body.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            srcStream.Body.on('end', () => resolve(Buffer.concat(chunks)));
            srcStream.Body.on('error', reject);
          });

          const { convertDocxBufferToPdfBuffer } = await import('../../services/docxToPdfService.js');
          const pdfBuf = await convertDocxBufferToPdfBuffer(docxBuf);

          const previewName = (policy.file?.original_name || policy.title || 'policy-preview').replace(/\.[^.]+$/, '') + '-preview.pdf';
          const upload = await uploadToS3(pdfBuf, previewName, 'application/pdf', '_marketplace', 'policy-template-preview');

          policy.file.pdf_preview_key = upload.key;
          await policy.save();
          s3Key = upload.key;
        } catch (err) {
          // Fall back to the legacy "no preview" message so the UI
          // can still render its purchase-to-download CTA.
          console.error('[marketplace] DOCX→PDF lazy convert failed:', err?.message || err);
          throw new AppError(
            'Preview generation failed — please try again or purchase to download.',
            500,
            'PREVIEW_CONVERSION_FAILED'
          );
        }
      } else {
        s3Key = policy.file.pdf_preview_key;
      }
    }

    if (!s3Key) throw new AppError('Policy has no file attached', 404, 'FILE_MISSING');

    const range = req.headers.range || null;
    const stream = await getFileStream(s3Key, range);

    // Surface "purchased?" + raw title so the frontend can decide
    // which watermark to draw — Stewardex (unpurchased) vs org-named
    // (purchased) — without a second round-trip.
    res.set({
      'Content-Type': stream.ContentType || 'application/pdf',
      'Content-Length': stream.ContentLength ?? undefined,
      'Cache-Control': 'private, no-store',
      // Discourage casual saving via Save-As / Ctrl+S — the browser
      // still allows it but the inline disposition keeps it in-tab.
      'Content-Disposition': 'inline',
      'X-Marketplace-Purchased': purchase ? '1' : '0',
      'X-Marketplace-Title': encodeURIComponent(policy.title || ''),
      // Block iframes from re-hosting the stream off-site.
      'X-Frame-Options': 'SAMEORIGIN'
    });
    if (stream.IsPartial) {
      res.status(206);
      if (stream.ContentRange) res.set('Content-Range', stream.ContentRange);
    }
    stream.Body.pipe(res);
  })
);

// ── Checkout — create a Stripe Checkout Session ─────────────────────

router.post(
  '/policies/:id/checkout',
  [
    param('id').isMongoId(),
    body('success_url').optional().isURL({ require_tld: false }),
    body('cancel_url').optional().isURL({ require_tld: false })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy, MarketplacePurchase, OrganizationSubscription } = getRouterModels();
    const policy = await MarketplacePolicy.findOne({ _id: req.params.id, status: 'published' }).lean();
    if (!policy) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');

    // Block re-purchase if the org already owns it.
    const existing = await MarketplacePurchase.findOne({
      org_id: req.orgId,
      policy_id: policy._id,
      status: 'paid'
    }).lean();
    if (existing) {
      return res.json({
        success: true,
        data: { already_purchased: true, purchase_id: existing._id.toString() }
      });
    }

    // Free template — short-circuit Stripe entirely so the tenant gets
    // immediate access without a $0 charge that Stripe rejects anyway
    // (minimum charge is A$0.50). We persist a paid row directly and
    // synchronously deliver so the response carries delivered_policy_id.
    if (policy.price_aud_cents === 0) {
      const purchase = await MarketplacePurchase.findOneAndUpdate(
        { org_id: req.orgId, policy_id: policy._id, status: 'paid' },
        {
          $setOnInsert: {
            org_id: req.orgId,
            policy_id: policy._id,
            amount_paid_cents: 0,
            currency: 'aud',
            stripe_session_id: '',
            stripe_payment_intent_id: '',
            stripe_customer_id: '',
            status: 'paid',
            purchased_at: new Date(),
            policy_title_snapshot: policy.title,
            policy_version_snapshot: policy.version || 1
          }
        },
        { upsert: true, new: true }
      );

      const { deliverPurchase } = await import('../../services/marketplaceDeliveryService.js');
      const delivery = await deliverPurchase(purchase._id).catch((err) => ({ ok: false, error: err?.message }));

      return res.json({
        success: true,
        data: {
          free: true,
          already_purchased: true,
          purchase_id: purchase._id.toString(),
          delivered_policy_id: delivery?.deliveredPolicyId || null,
          delivery_error: delivery?.ok ? null : delivery?.error
        }
      });
    }

    // Reuse the tenant's existing Stripe customer where possible so
    // their card-on-file applies and the customer id is consistent
    // with the subscription history.
    const existingSub = await OrganizationSubscription.findOne({ organization_id: req.orgId });
    let customerId = existingSub?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await ensureStripeCustomer({
        orgId: req.orgId,
        email: req.user?.email,
        name: req.orgId
      });
      customerId = customer.id;
    }

    // Resolve a usable frontend origin. Priority:
    //   1. URLs the client explicitly passed in (window.location.origin
    //      — most reliable across dev/preview/prod environments)
    //   2. FRONTEND_URL env via serverConfig
    //   3. Origin / Referer headers on the request as a last resort
    // Stripe rejects anything that isn't a fully-qualified http(s):// URL,
    // so we validate before sending.
    const headerOrigin = (req.get('origin') || req.get('referer') || '').replace(/\/$/, '');
    const envOrigin    = (serverConfig.frontendUrl || '').replace(/\/$/, '');
    const fallbackOrigin = envOrigin || headerOrigin || '';

    const successUrl = req.body.success_url
      || `${fallbackOrigin}/policies/marketplace/${policy._id}?checkout=success`;
    const cancelUrl  = req.body.cancel_url
      || `${fallbackOrigin}/policies/marketplace/${policy._id}?checkout=cancel`;

    const isAbsoluteHttpUrl = (u) => /^https?:\/\/[^\s/]+/.test(u || '');
    if (!isAbsoluteHttpUrl(successUrl) || !isAbsoluteHttpUrl(cancelUrl)) {
      throw new AppError(
        'Could not resolve a valid frontend URL for Stripe Checkout. Pass success_url/cancel_url in the request body, or set FRONTEND_URL on the server.',
        500,
        'CHECKOUT_URL_INVALID'
      );
    }

    // Pre-flight: the price_aud_cents is already in minor units. Pass
    // it directly to Stripe — no *100 or /100 anywhere in this flow
    // means there's no math bug surface.
    const priceCents = Number(policy.price_aud_cents);
    if (!Number.isInteger(priceCents) || priceCents < 50) {
      // Stripe AUD minimum is A$0.50 (50 cents); anything lower is a
      // configuration error in the catalogue.
      throw new AppError(
        'Price must be at least A$0.50 for a Stripe charge.',
        400,
        'PRICE_BELOW_STRIPE_MINIMUM'
      );
    }

    // Compose the Checkout Session inline. We're not going through
    // chargeOutstandingOverage() because the metadata + line-item
    // copy is policy-specific and that helper is geared to overages.
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(serverConfig.stripeSecretKey || process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{
        price_data: {
          currency: 'aud',
          unit_amount: priceCents, // ← straight cents, no conversion
          product_data: {
            name: policy.title.slice(0, 250),
            description: (policy.summary || policy.description || 'Stewardex policy template').slice(0, 500)
          }
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      // Both `metadata` and `payment_intent_data.metadata` are set —
      // the webhook reads either, depending on which event fires.
      metadata: {
        kind: 'marketplace_policy',
        orgId: req.orgId,
        policy_id: policy._id.toString(),
        policy_title: policy.title.slice(0, 100),
        policy_version: String(policy.version || 1)
      },
      payment_intent_data: {
        description: `Stewardex policy: ${policy.title}`.slice(0, 200),
        metadata: {
          kind: 'marketplace_policy',
          orgId: req.orgId,
          policy_id: policy._id.toString()
        }
      }
    });

    // Record a pending purchase so we can correlate the webhook later
    // and so the org sees the in-flight intent in their history.
    await MarketplacePurchase.create({
      org_id: req.orgId,
      policy_id: policy._id,
      amount_paid_cents: priceCents,
      currency: 'aud',
      stripe_session_id: session.id,
      stripe_customer_id: customerId,
      status: 'pending',
      policy_title_snapshot: policy.title,
      policy_version_snapshot: policy.version || 1
    }).catch((err) => {
      // Duplicate-key on stripe_session_id means we already recorded
      // it — safe to ignore.
      if (err?.code !== 11000) throw err;
    });

    res.json({
      success: true,
      data: {
        checkout_url: session.url,
        session_id: session.id,
        amount_aud_cents: priceCents
      }
    });
  })
);

// ── Org's purchase history ──────────────────────────────────────────

router.get(
  '/purchases',
  asyncHandler(async (req, res) => {
    const { MarketplacePurchase, MarketplacePolicy } = getRouterModels();
    const rows = await MarketplacePurchase
      .find({ org_id: req.orgId, status: 'paid' })
      .sort({ purchased_at: -1 })
      .lean();

    // Join the live policy doc so the user sees the current title /
    // group even if it was renamed since purchase. (The snapshot in
    // the purchase row is the historical record.)
    const policyIds = rows.map((r) => r.policy_id);
    const policies = policyIds.length
      ? await MarketplacePolicy.find({ _id: { $in: policyIds } }).lean()
      : [];
    const byId = Object.fromEntries(policies.map((p) => [p._id.toString(), p]));

    res.json({
      success: true,
      data: rows.map((r) => {
        const p = byId[r.policy_id.toString()];
        return {
          id: r._id.toString(),
          policy_id: r.policy_id.toString(),
          policy_title: p?.title || r.policy_title_snapshot,
          policy_format: p?.file?.format || 'pdf',
          amount_paid_cents: r.amount_paid_cents,
          purchased_at: r.purchased_at
        };
      })
    });
  })
);

export default router;
