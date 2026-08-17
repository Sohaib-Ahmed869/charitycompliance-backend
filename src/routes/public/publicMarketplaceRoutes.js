/**
 * Public Policy Marketplace — UNAUTHENTICATED routes for the marketing
 * site at /marketplace.
 *
 *   GET  /public/marketplace/policies               — list published
 *   GET  /public/marketplace/policies/:id           — single policy
 *   GET  /public/marketplace/policies/:id/preview-stream
 *                                                   — page-1 PDF stream
 *   POST /public/marketplace/policies/:id/checkout  — Stripe Checkout
 *                                                     (one-off payment)
 *   POST /public/marketplace/reconcile-checkout     — webhook fallback,
 *                                                     mark a session paid
 *   POST /public/marketplace/claim/:token           — buyer enters
 *                                                     org name + uploads
 *                                                     logo, gets PDF
 *   GET  /public/marketplace/claim/:token           — lookup by token
 *                                                     (post-Stripe page)
 *   GET  /public/marketplace/download/:token        — re-download the
 *                                                     watermarked PDF
 *
 * Identity model: opaque `claim_token` minted at checkout time and
 * baked into Stripe's success_url. The buyer can only finish the
 * claim if they hold that token. Email is stored for the receipt and
 * re-download link.
 */

import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { param, body, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler, AppError } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { getFileStream, uploadToS3 } from '../../services/s3Service.js';
import {
  isStripeConfigured,
  retrieveCheckoutSession
} from '../../services/stripeService.js';
import { server as serverConfig } from '../../config/index.js';
import { logError, logInfo } from '../../utils/logger.js';
import { isPolicyMarketplaceEnabled } from '../../middleware/marketplaceGate.js';

const router = express.Router();

/**
 * GET /public/marketplace/status — is the marketplace switched on
 * inside Stewardex?
 *
 * The SuperAdmin kill switch controls the Stewardex-embedded surfaces:
 * the marketing site calls this to decide whether to render the
 * Marketplace nav link and /marketplace page, and the in-app
 * /platform/marketplace routes are hard-gated by the same flag.
 *
 * The rest of this router is intentionally NOT gated — the standalone
 * marketplace frontend (separately deployed, its own domain) is powered
 * by these endpoints and stays live regardless of the switch.
 */
router.get('/status', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { enabled: await isPolicyMarketplaceEnabled() } });
}));

// 5 MB cap — logo is a single PNG/JPG, anything bigger is a mistake.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

function serializePublic(p) {
  return {
    id: p._id?.toString(),
    // group_id lets the frontend keep cards bucketed by group without a
    // second round-trip for every render (the /groups endpoint still
    // provides the human-readable name + slug + sort order).
    group_id: p.group_id?.toString() || '',
    title: p.title,
    summary: p.summary || '',
    description: p.description || '',
    price_aud_cents: p.price_aud_cents ?? 0,
    price_aud: ((p.price_aud_cents ?? 0) / 100),
    file: {
      format: p.file?.format || 'pdf'
    },
    tags: p.tags || [],
    version: p.version ?? 1
  };
}

// ── Listing ─────────────────────────────────────────────────────────

/**
 * GET /public/marketplace/groups
 *
 * Active groups with their published-policy count, sorted the same way
 * the admin catalogue is. Used by the marketplace page to render group
 * chips at the top; clicking a chip narrows the policies query, which
 * is what keeps the PDF-preview thumbnail load down to a handful of
 * cards at a time instead of every published policy at once.
 */
router.get('/groups', asyncHandler(async (_req, res) => {
  const { MarketplacePolicyGroup, MarketplacePolicy } = getRouterModels();
  const groups = await MarketplacePolicyGroup
    .find({ status: 'active' })
    .sort({ sort_order: 1, name: 1 })
    .lean();

  // One round-trip to count policies per group. We use an aggregation
  // grouped by group_id so this scales cleanly as the catalogue grows
  // beyond the current ~120 policies.
  const counts = await MarketplacePolicy.aggregate([
    { $match: { status: 'published' } },
    { $group: { _id: '$group_id', n: { $sum: 1 } } }
  ]);
  const countByGroup = new Map(counts.map((c) => [String(c._id), c.n]));

  const data = groups.map((g) => ({
    id: g._id?.toString(),
    name: g.name,
    slug: g.slug,
    description: g.description || '',
    sort_order: g.sort_order ?? 100,
    accent_color: g.accent_color || '',
    policy_count: countByGroup.get(String(g._id)) || 0
  }));
  res.json({ success: true, data });
}));

/**
 * GET /public/marketplace/policies
 *
 * Pagination + filtering. Accepts:
 *   group   — group id (hex) or slug. Narrows to one group only.
 *   q       — title search (case-insensitive prefix match on `title`).
 *   page    — 1-based, default 1.
 *   limit   — default 12, max 50.
 *
 * Returns `{ data, meta: { total, page, limit, pages } }`. The meta
 * envelope is what the frontend pagination controls render from.
 */
router.get(
  '/policies',
  [
    query('group').optional().isString().trim().isLength({ max: 80 }),
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy, MarketplacePolicyGroup } = getRouterModels();

    const page = req.query.page || 1;
    const limit = req.query.limit || 12;
    const skip = (page - 1) * limit;

    const filter = { status: 'published' };

    // Resolve `group` — accept either a 24-hex Mongo id or a slug. Falls
    // back to "no group filter" if a slug doesn't match anything live, so
    // a stale bookmark from a renamed group doesn't 404 the page.
    if (req.query.group) {
      const groupArg = String(req.query.group).trim();
      if (/^[0-9a-fA-F]{24}$/.test(groupArg)) {
        filter.group_id = groupArg;
      } else {
        const grp = await MarketplacePolicyGroup.findOne({ slug: groupArg.toLowerCase(), status: 'active' }).lean();
        if (grp) filter.group_id = grp._id;
      }
    }

    // Simple case-insensitive title contains-match. Mongo can't use an
    // index on a leading-anchored regex with $options:'i', so this is a
    // collection scan within the group filter — fine at our catalogue
    // size; revisit if we ever cross ~10k policies.
    if (req.query.q) {
      const escaped = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.title = { $regex: escaped, $options: 'i' };
    }

    const [total, policies] = await Promise.all([
      MarketplacePolicy.countDocuments(filter),
      MarketplacePolicy
        .find(filter)
        .sort({ sort_order: 1, title: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    res.json({
      success: true,
      data: policies.map(serializePublic),
      meta: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  })
);

router.get(
  '/policies/:id',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const policy = await MarketplacePolicy.findOne({ _id: req.params.id, status: 'published' }).lean();
    if (!policy) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');
    res.json({ success: true, data: serializePublic(policy) });
  })
);

// ── Page-1 preview stream ───────────────────────────────────────────
// Same shape as the authenticated preview-stream but we never need an
// org-purchased flag here (everyone is a prospect). Note that for
// DOCX policies the marketplace stores a pre-converted PDF preview
// key, so we can rely on the existing s3 key trio.

router.get(
  '/policies/:id/preview-stream',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const policy = await MarketplacePolicy.findOne({ _id: req.params.id, status: 'published' });
    if (!policy) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');

    // ── Fast path: cached branded preview ────────────────────────────
    // The first request brands a single-page preview and stows the S3
    // key on the policy. Every subsequent card render / modal open just
    // streams those bytes — no pdf-lib branding, no whole-document
    // download. Cleared automatically when an admin replaces the file
    // (the whole `file` subdoc is reassigned).
    if (policy.file?.branded_preview_key) {
      try {
        const cached = await getFileStream(policy.file.branded_preview_key);
        res.set({
          'Content-Type': 'application/pdf',
          'Content-Length': cached.ContentLength ?? undefined,
          // Long cache — the bytes only change when the policy file is
          // replaced, which mints a new key, so this URL is immutable
          // for the life of the current file.
          'Cache-Control': 'public, max-age=86400',
          'Content-Disposition': 'inline',
          'X-Frame-Options': 'SAMEORIGIN'
        });
        cached.Body.pipe(res);
        return;
      } catch (err) {
        // Cached object went missing (e.g. S3 lifecycle / manual delete)
        // — fall through and regenerate it below.
        logError('[public marketplace] cached preview read failed, regenerating:', err?.message || err);
      }
    }

    let s3Key = policy.file?.pdf_preview_key || policy.file?.s3_key;

    if (policy.file?.format === 'docx' && !policy.file?.pdf_preview_key) {
      // Lazy DOCX → PDF conversion (cached). Mirrors the auth'd path.
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
        const uploaded = await uploadToS3(pdfBuf, previewName, 'application/pdf', '_marketplace', 'policy-template-preview');
        policy.file.pdf_preview_key = uploaded.key;
        await policy.save();
        s3Key = uploaded.key;
      } catch (err) {
        logError('[public marketplace] preview convert failed:', err?.message || err);
        throw new AppError('Preview generation failed.', 500, 'PREVIEW_CONVERSION_FAILED');
      }
    }

    if (!s3Key) throw new AppError('Policy has no file attached', 404, 'FILE_MISSING');

    // Brand the public preview with Stewardex (cover page + per-page
    // top-right logo) — keeps the marketing/marketplace presentation
    // consistent regardless of whether the visitor logs in or not.
    const stream = await getFileStream(s3Key);
    const sourceBytes = await new Promise((resolve, reject) => {
      const chunks = [];
      stream.Body.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.Body.on('end', () => resolve(Buffer.concat(chunks)));
      stream.Body.on('error', reject);
    });
    const { brandStewardexPreviewPdf } = await import('../../services/policyPdfBrandingService.js');
    // Single-page preview: the marketplace only ever shows page 1, so we
    // brand + ship one page rather than the whole document.
    const branded = await brandStewardexPreviewPdf(sourceBytes, { firstPageOnly: true });

    // Cache the branded preview on S3 so the next request hits the fast
    // path above. Best-effort — a failed upload still serves this
    // response, it just means we re-brand next time.
    try {
      const previewName = (policy.title || 'policy').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) + '-card-preview.pdf';
      const uploaded = await uploadToS3(branded, previewName, 'application/pdf', '_marketplace', 'policy-template-card-preview');
      policy.file.branded_preview_key = uploaded.key;
      await policy.save();
    } catch (err) {
      logError('[public marketplace] branded preview cache write failed:', err?.message || err);
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': branded.length,
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': 'inline',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    res.end(branded);
  })
);

// ── Checkout ────────────────────────────────────────────────────────

router.post(
  '/policies/:id/checkout',
  [
    param('id').isMongoId(),
    body('email').isEmail().normalizeEmail(),
    body('success_url').optional().isURL({ require_tld: false }),
    body('cancel_url').optional().isURL({ require_tld: false })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured.' }
      });
    }
    const { MarketplacePolicy, MarketplacePublicPurchase } = getRouterModels();
    const policy = await MarketplacePolicy.findOne({ _id: req.params.id, status: 'published' }).lean();
    if (!policy) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');

    const priceCents = Number(policy.price_aud_cents);
    if (!Number.isInteger(priceCents) || priceCents < 50) {
      throw new AppError('Price must be at least A$0.50 for a Stripe charge.', 400, 'PRICE_BELOW_STRIPE_MINIMUM');
    }

    // Origin / referer beats env so checkout always bounces back to
    // wherever the buyer actually is — mirrors the tenant checkout.
    const headerOriginRaw = (req.get('origin') || req.get('referer') || '').replace(/\/$/, '');
    let headerOrigin = '';
    try { headerOrigin = headerOriginRaw ? new URL(headerOriginRaw).origin : ''; }
    catch { headerOrigin = headerOriginRaw; }
    const envOrigin = (serverConfig.frontendUrl || '').replace(/\/$/, '');
    const fallbackOrigin = headerOrigin || envOrigin || '';

    // Generate the claim token *before* the Stripe call so we can stamp
    // it into both the success_url and the local row.
    const claimToken = crypto.randomBytes(24).toString('hex');

    const successUrl = req.body.success_url
      || `${fallbackOrigin}/marketplace/claim/${claimToken}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = req.body.cancel_url
      || `${fallbackOrigin}/marketplace/policies/${policy._id}?checkout=cancel`;

    const isAbsoluteHttpUrl = (u) => /^https?:\/\/[^\s/]+/.test(u || '');
    if (!isAbsoluteHttpUrl(successUrl) || !isAbsoluteHttpUrl(cancelUrl)) {
      throw new AppError('Could not resolve a frontend URL for Stripe Checkout.', 500, 'CHECKOUT_URL_INVALID');
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(serverConfig.stripeSecretKey || process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.body.email,
      line_items: [{
        price_data: {
          currency: 'aud',
          unit_amount: priceCents,
          product_data: {
            name: policy.title.slice(0, 250),
            description: (policy.summary || policy.description || 'Stewardex policy template').slice(0, 500)
          }
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      metadata: {
        kind: 'marketplace_policy_public',
        policy_id: policy._id.toString(),
        policy_title: policy.title.slice(0, 100),
        claim_token: claimToken,
        buyer_email: req.body.email
      },
      payment_intent_data: {
        description: `Stewardex policy: ${policy.title}`.slice(0, 200),
        metadata: {
          kind: 'marketplace_policy_public',
          policy_id: policy._id.toString(),
          claim_token: claimToken
        }
      }
    });

    await MarketplacePublicPurchase.create({
      policy_id: policy._id,
      buyer_email: req.body.email,
      claim_token: claimToken,
      amount_paid_cents: priceCents,
      currency: 'aud',
      stripe_session_id: session.id,
      status: 'pending',
      policy_title_snapshot: policy.title,
      policy_version_snapshot: policy.version || 1
    }).catch((err) => {
      if (err?.code !== 11000) throw err;
    });

    res.json({
      success: true,
      data: { checkout_url: session.url, session_id: session.id, claim_token: claimToken }
    });
  })
);

// ── Reconcile (webhook fallback) ────────────────────────────────────
// Same role as /platform/marketplace/policies/reconcile-checkout but
// keyed by claim_token so a guest with no JWT can still finalise.

router.post(
  '/reconcile-checkout',
  [
    body('session_id').isString().trim().notEmpty(),
    body('claim_token').isString().trim().isLength({ min: 16, max: 96 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not yet configured.' }
      });
    }
    const { MarketplacePublicPurchase } = getRouterModels();
    const session = await retrieveCheckoutSession(req.body.session_id);
    if (!session) throw new AppError('Session not found.', 404, 'SESSION_NOT_FOUND');
    if (session.metadata?.claim_token !== req.body.claim_token) {
      throw new AppError('Claim token does not match session.', 403, 'TOKEN_MISMATCH');
    }
    if ((session.metadata?.kind || '') !== 'marketplace_policy_public') {
      throw new AppError('Wrong session kind.', 409, 'WRONG_SESSION_KIND');
    }
    if (session.payment_status !== 'paid') {
      throw new AppError(`Session not paid yet: ${session.payment_status}.`, 409, 'SESSION_NOT_PAID');
    }
    const purchase = await MarketplacePublicPurchase.findOne({ claim_token: req.body.claim_token });
    if (!purchase) throw new AppError('Purchase row missing.', 404, 'PURCHASE_NOT_FOUND');
    if (purchase.status === 'pending') {
      purchase.status = 'paid';
      purchase.paid_at = new Date();
      purchase.stripe_payment_intent_id = typeof session.payment_intent === 'string'
        ? session.payment_intent : session.payment_intent?.id || '';
      purchase.stripe_customer_id = typeof session.customer === 'string'
        ? session.customer : session.customer?.id || '';
      await purchase.save();
    }
    res.json({
      success: true,
      data: {
        claim_token: purchase.claim_token,
        status: purchase.status,
        policy_title: purchase.policy_title_snapshot
      }
    });
  })
);

// ── Lookup by claim token (post-checkout page bootstrap) ────────────

router.get(
  '/claim/:token',
  [param('token').isString().trim().isLength({ min: 16, max: 96 })],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePublicPurchase, MarketplacePolicy } = getRouterModels();
    const purchase = await MarketplacePublicPurchase.findOne({ claim_token: req.params.token }).lean();
    if (!purchase) throw new AppError('Claim not found', 404, 'CLAIM_NOT_FOUND');
    const policy = await MarketplacePolicy.findById(purchase.policy_id).lean();
    res.json({
      success: true,
      data: {
        claim_token: purchase.claim_token,
        status: purchase.status,
        policy: policy ? serializePublic(policy) : null,
        buyer_email: purchase.buyer_email,
        buyer_org_name: purchase.buyer_org_name || '',
        already_claimed: purchase.status === 'claimed',
        delivered_file_name: purchase.delivered_file_name || ''
      }
    });
  })
);

// ── Claim: buyer enters org name + logo, gets PDF ───────────────────
// multer parses multipart/form-data with one file field ("logo").

router.post(
  '/claim/:token',
  upload.single('logo'),
  [
    param('token').isString().trim().isLength({ min: 16, max: 96 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const orgName = String(req.body.org_name || '').trim();
    if (!orgName) {
      throw new AppError('Organisation name is required.', 400, 'ORG_NAME_REQUIRED');
    }
    // 'pdf' (watermarked, locked) or 'docx' (branded, editable). Anything
    // unrecognised falls back to PDF.
    const format = String(req.body.format || 'pdf').toLowerCase() === 'docx' ? 'docx' : 'pdf';

    const { MarketplacePublicPurchase, MarketplacePolicy } = getRouterModels();
    const purchase = await MarketplacePublicPurchase.findOne({ claim_token: req.params.token });
    if (!purchase) throw new AppError('Claim not found', 404, 'CLAIM_NOT_FOUND');
    if (purchase.status === 'pending') {
      throw new AppError('Payment not confirmed yet — try again in a few seconds.', 409, 'NOT_PAID_YET');
    }
    if (purchase.status === 'refunded') {
      throw new AppError('This purchase was refunded.', 410, 'REFUNDED');
    }
    if (purchase.status === 'claimed' && purchase.delivered_s3_key) {
      // Idempotent re-claim — return the existing PDF so the same form
      // submission can be retried without erroring out.
      return res.json({
        success: true,
        data: {
          claim_token: purchase.claim_token,
          status: purchase.status,
          delivered_file_name: purchase.delivered_file_name,
          already_claimed: true
        }
      });
    }

    const policy = await MarketplacePolicy.findById(purchase.policy_id).lean();
    if (!policy) throw new AppError('Policy missing', 410, 'POLICY_MISSING');

    // Atomic claim — second concurrent submit gets 409.
    const claimed = await MarketplacePublicPurchase.findOneAndUpdate(
      {
        _id: purchase._id,
        status: 'paid',
        delivery_status: { $nin: ['delivered', 'in_progress'] }
      },
      { $set: { delivery_status: 'in_progress' } },
      { new: true }
    );
    if (!claimed) {
      throw new AppError('Claim is already in progress.', 409, 'CLAIM_IN_PROGRESS');
    }

    let logoBytes = null;
    let logoMime = '';
    if (req.file) {
      logoBytes = req.file.buffer;
      logoMime = (req.file.mimetype || '').toLowerCase();
    }

    try {
      const { deliverPublicPurchase } = await import('../../services/publicMarketplaceDeliveryService.js');
      const result = await deliverPublicPurchase({
        purchaseId: purchase._id,
        orgName,
        logoBytes,
        logoMime,
        policy,
        format
      });
      if (!result.ok) {
        purchase.delivery_status = 'failed';
        purchase.delivery_error = result.error || 'Delivery failed.';
        await purchase.save();
        throw new AppError(result.error || 'Delivery failed.', 500, 'DELIVERY_FAILED');
      }

      // Send the email with a download link (best-effort — main
      // delivery doesn't depend on it).
      try {
        const { sendPolicyDeliveryEmail } = await import('../../services/publicMarketplaceDeliveryService.js');
        await sendPolicyDeliveryEmail({
          to: purchase.buyer_email,
          orgName,
          policyTitle: policy.title,
          claimToken: purchase.claim_token,
          frontendBase: (req.get('origin') || serverConfig.frontendUrl || '').replace(/\/$/, '')
        });
      } catch (mailErr) {
        logError('[public marketplace] receipt email failed:', mailErr?.message || mailErr);
      }

      const fresh = await MarketplacePublicPurchase.findById(purchase._id).lean();
      logInfo(`[public marketplace] claim delivered: token=${purchase.claim_token.slice(0, 8)}…, policy=${policy._id}`);
      res.json({
        success: true,
        data: {
          claim_token: purchase.claim_token,
          status: fresh.status,
          delivered_file_name: fresh.delivered_file_name,
          delivered_format: fresh.delivered_format || 'pdf',
          download_url: `/api/v1/public/marketplace/download/${purchase.claim_token}`
        }
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      logError('[public marketplace] claim failed:', err?.message || err);
      purchase.delivery_status = 'failed';
      purchase.delivery_error = err?.message || 'Delivery failed.';
      await purchase.save();
      throw new AppError('Delivery failed.', 500, 'DELIVERY_FAILED');
    }
  })
);

// ── Re-download ─────────────────────────────────────────────────────
// Buyer presents their claim_token (in URL, from email or local
// storage) and we stream the watermarked PDF back. Same content,
// served forever for that token — there's no expiry on the row but
// the token itself is high-entropy.

router.get(
  '/download/:token',
  [param('token').isString().trim().isLength({ min: 16, max: 96 })],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePublicPurchase } = getRouterModels();
    const purchase = await MarketplacePublicPurchase.findOne({ claim_token: req.params.token }).lean();
    if (!purchase) throw new AppError('Claim not found', 404, 'CLAIM_NOT_FOUND');
    if (purchase.status !== 'claimed' || !purchase.delivered_s3_key) {
      throw new AppError('This purchase has not been finalised yet.', 409, 'NOT_CLAIMED');
    }
    const range = req.headers.range || null;
    const stream = await getFileStream(purchase.delivered_s3_key, range);
    const safeName = (purchase.delivered_file_name || 'policy').replace(/[^a-z0-9._-]+/gi, '_');
    res.set({
      'Content-Type': stream.ContentType || 'application/pdf',
      'Content-Length': stream.ContentLength ?? undefined,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${safeName}"`
    });
    if (stream.IsPartial) {
      res.status(206);
      if (stream.ContentRange) res.set('Content-Range', stream.ContentRange);
    }
    stream.Body.pipe(res);
  })
);

export default router;
