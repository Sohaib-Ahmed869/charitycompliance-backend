/**
 * marketplaceDeliveryService — post-purchase fulfilment for Policy
 * Marketplace orders.
 *
 * Triggered by the Stripe webhook after a checkout.session.completed
 * with metadata.kind === 'marketplace_policy' has flipped the
 * MarketplacePurchase row to paid. It:
 *
 *   1. Pulls the original PDF bytes from S3
 *   2. Watermarks every page with the org's logo (header band) plus
 *      a faint "Licensed to <Org Name>" diagonal repeat
 *   3. Uploads the watermarked PDF under the tenant's S3 prefix
 *   4. Creates a Policy row in the tenant's own database so the
 *      template appears alongside the org's other policies
 *   5. Stamps purchase.delivered_policy_id + delivery_status
 *
 * Idempotent: re-running on an already-delivered purchase no-ops.
 * Failures are caught, logged, and recorded on the purchase row so
 * a support agent can retry from the admin tools.
 *
 * Pure JS — uses pdf-lib for the PDF manipulation (no native deps,
 * deploys cleanly on Render). DOCX policies fall back to "copy the
 * raw file with no watermark" because pdf-lib can't touch DOCX; the
 * source file is still licensed and tracked through MarketplacePurchase.
 */

import { uploadToS3, getFileStream } from './s3Service.js';
import { convertDocxBufferToPdfBuffer } from './docxToPdfService.js';
import { getTenantConnection } from '../db/connectionManager.js';
import getRouterModels from '../db/models/routerModels.js';
import organizationSchema from '../db/schemas/platform/organizationSchema.js';
import policySchema from '../db/schemas/platform/policySchema.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { brandMarketplacePdf } from './policyPdfBrandingService.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

// ── helpers ─────────────────────────────────────────────────────────

/** Collect an S3 stream into a Buffer. */
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Turn a data: URL or http URL into PNG/JPG bytes pdf-lib can embed.
 *
 * Handles the common variants of data URLs:
 *   data:image/png;base64,...
 *   data:image/png;name=logo.png;base64,...     (some browsers add this)
 *   data:image/png;charset=utf-8;base64,...     (rare but valid)
 *
 * Returns null when the URL is missing, empty, or can't be parsed —
 * caller falls back to the org-name text header.
 */
async function fetchLogoBytes(logoUrl) {
  if (!logoUrl) return null;
  const raw = String(logoUrl).trim();
  if (!raw) return null;

  if (raw.startsWith('data:')) {
    // Split on the FIRST comma — everything before is the metadata,
    // everything after is the payload. base64 alphabet never includes
    // commas so the split is unambiguous.
    const commaIdx = raw.indexOf(',');
    if (commaIdx === -1) {
      logWarn(`[marketplace] logo data URL missing comma — length=${raw.length}`);
      return null;
    }
    const meta = raw.slice(5, commaIdx); // strip "data:"
    const payload = raw.slice(commaIdx + 1);
    const metaParts = meta.split(';').map((p) => p.trim().toLowerCase());
    const mime = metaParts[0] || 'application/octet-stream';
    const isBase64 = metaParts.includes('base64');
    if (!isBase64) {
      logWarn(`[marketplace] logo data URL not base64-encoded (mime=${mime})`);
      return null;
    }
    let bytes;
    try {
      bytes = Buffer.from(payload, 'base64');
    } catch (err) {
      logError('[marketplace] logo base64 decode failed:', err?.message || err);
      return null;
    }
    logInfo(`[marketplace] logo decoded: mime=${mime}, bytes=${bytes.length}`);
    return { bytes, mime };
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const r = await fetch(raw);
      if (!r.ok) {
        logWarn(`[marketplace] logo http fetch returned ${r.status} for ${raw.slice(0, 80)}`);
        return null;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = (r.headers.get('content-type') || '').toLowerCase();
      logInfo(`[marketplace] logo fetched: mime=${mime}, bytes=${buf.length}`);
      return { bytes: buf, mime };
    } catch (err) {
      logError('[marketplace] logo fetch failed:', err?.message || err);
      return null;
    }
  }
  logWarn(`[marketplace] logo URL has unrecognised scheme (first 30 chars: "${raw.slice(0, 30)}")`);
  return null;
}

// Watermarking lives in policyPdfBrandingService.js (a cover page +
// a per-page top-right logo). Kept as a thin wrapper so the rest of
// this file's call sites don't have to thread the policy title /
// purchase date through manually.

/**
 * deliverPurchase — main entry point. Idempotent: safe to call twice.
 * Returns { ok: true, deliveredPolicyId } on success; { ok: false, error }
 * otherwise.
 */
export async function deliverPurchase(purchaseId) {
  const { MarketplacePurchase, MarketplacePolicy } = getRouterModels();

  // ── Atomic claim ──────────────────────────────────────────────────
  // Webhook delivery and the frontend's reconcile-checkout call can
  // both invoke this fn at roughly the same instant. Without an
  // atomic flip on the purchase row, both readers would see
  // delivery_status='pending' and end up creating two Policy rows in
  // the tenant DB (the exact bug the user reported). findOneAndUpdate
  // with the not-delivered/not-in-progress predicate is the lock — one
  // call flips to 'in_progress' and proceeds; the other gets null and
  // either returns the already-delivered row or backs off.
  const claimed = await MarketplacePurchase.findOneAndUpdate(
    {
      _id: purchaseId,
      status: 'paid',
      delivery_status: { $nin: ['delivered', 'in_progress'] }
    },
    { $set: { delivery_status: 'in_progress' } },
    { new: true }
  );

  if (!claimed) {
    const existing = await MarketplacePurchase.findById(purchaseId).lean();
    if (!existing) return { ok: false, error: 'Purchase not found' };
    if (existing.delivery_status === 'delivered' && existing.delivered_policy_id) {
      return {
        ok: true,
        deliveredPolicyId: existing.delivered_policy_id,
        workflowPending: !!existing.workflow_pending,
        workflowMessage: existing.delivery_error || '',
        alreadyDelivered: true
      };
    }
    if (existing.status !== 'paid') return { ok: false, error: 'Purchase not paid' };
    // Another worker holds the claim — back off so we don't double-deliver.
    return { ok: false, error: 'Delivery already in progress', inProgress: true };
  }
  const purchase = claimed;

  const policy = await MarketplacePolicy.findById(purchase.policy_id).lean();
  if (!policy) {
    purchase.delivery_status = 'failed';
    purchase.delivery_error = 'Marketplace policy missing';
    await purchase.save();
    return { ok: false, error: 'Policy missing' };
  }

  // ── Pull the source file from S3 ──────────────────────────────────
  const sourceKey = policy.file?.s3_key;
  if (!sourceKey) {
    purchase.delivery_status = 'failed';
    purchase.delivery_error = 'Policy file missing';
    await purchase.save();
    return { ok: false, error: 'Policy file missing' };
  }

  // ── Look up the org's logo + display name from the tenant DB ─────
  // We connect to the tenant DB on-the-fly; the connection manager
  // pools per-cluster so this is cheap on repeat.
  let orgLogoUrl = '';
  let orgDisplayName = purchase.org_id;
  let tenantConn = null;
  try {
    tenantConn = await getTenantConnection(purchase.org_id);
    const Organization = tenantConn.model('Organization', organizationSchema);
    const org = await Organization.findOne({}).lean();
    if (org) {
      orgLogoUrl = org.logo_url || '';
      orgDisplayName = org.name || org.legal_name || purchase.org_id;
      logInfo(`[marketplace] org ${purchase.org_id} resolved: name="${orgDisplayName}", logo_url_present=${!!orgLogoUrl}, logo_starts_with="${orgLogoUrl ? orgLogoUrl.slice(0, 30) : ''}"`);
    } else {
      logWarn(`[marketplace] no Organization doc in tenant DB for ${purchase.org_id}`);
    }
  } catch (err) {
    logError('[marketplace] could not load tenant org for', purchase.org_id, err?.message);
    // Non-fatal — we just deliver without a logo.
  }

  let watermarkedKey;
  let watermarkedBytes;
  let watermarkedMime;
  let originalName;

  try {
    const stream = await getFileStream(sourceKey);
    const sourceBytes = await streamToBuffer(stream.Body);

    // Resolve PDF bytes first — for DOCX marketplace templates we
    // render to PDF up-front so the same pdf-lib watermark path adds
    // the org logo on top. Delivering as PDF (rather than the original
    // DOCX) is intentional: it's the only way to get a branded header,
    // and it's a more lock-down format than an editable Word doc.
    let pdfBytes = null;
    if (policy.file?.format === 'pdf') {
      pdfBytes = sourceBytes;
    } else {
      // DOCX → PDF. Same conversion used by the preview-stream route,
      // so the output is consistent with what the buyer previewed.
      logInfo(`[marketplace] converting DOCX → PDF for ${policy.title}`);
      pdfBytes = await convertDocxBufferToPdfBuffer(sourceBytes);
    }

    // Prepend a branded cover page and stamp a small top-right logo
    // on every other page. Logic lives in policyPdfBrandingService so
    // tenant + public marketplace deliveries stay visually identical.
    const logo = orgLogoUrl ? await fetchLogoBytes(orgLogoUrl) : null;
    watermarkedBytes = await brandMarketplacePdf(pdfBytes, {
      orgName: orgDisplayName,
      logoBytes: logo?.bytes,
      logoMime: logo?.mime,
      policyTitle: policy.title,
      purchasedAt: purchase.purchased_at || new Date()
    });
    watermarkedMime = 'application/pdf';
    const baseName = (policy.file?.original_name || policy.title || 'policy').replace(/\.[^.]+$/, '');
    originalName = `${baseName}.pdf`;

    const upload = await uploadToS3(
      watermarkedBytes,
      originalName,
      watermarkedMime,
      purchase.org_id,
      'policy-marketplace'
    );
    watermarkedKey = upload.key;
  } catch (err) {
    logError('[marketplace] watermark/upload failed:', err?.message || err);
    purchase.delivery_status = 'failed';
    purchase.delivery_error = `watermark/upload: ${err?.message || err}`;
    await purchase.save();
    return { ok: false, error: err?.message || 'Watermark failed' };
  }

  // ── Create the tenant-side Policy row ────────────────────────────
  // Land as `under_review` so the approval workflow drives publication —
  // mirrors how a manually-uploaded policy behaves. If no workflow is
  // configured for policies, we downgrade to `draft` below and surface
  // that on the purchase row so the buyer sees a clear "create a
  // workflow to publish" message.
  let deliveredPolicyId = null;
  try {
    if (!tenantConn) tenantConn = await getTenantConnection(purchase.org_id);
    const Organization = tenantConn.model('Organization', organizationSchema);
    const Policy = tenantConn.model('Policy', policySchema);
    const org = await Organization.findOne({}).lean();
    if (!org) {
      purchase.delivery_status = 'failed';
      purchase.delivery_error = 'No Organization document in tenant DB';
      await purchase.save();
      return { ok: false, error: 'Tenant org missing' };
    }
    const created = await Policy.create({
      org_id: org._id,
      title: policy.title,
      category: 'Marketplace',
      description: policy.description || policy.summary || '',
      file_name: originalName,
      file_path: watermarkedKey,
      file_size: watermarkedBytes.length,
      mime_type: watermarkedMime,
      version: `v${policy.version || 1}`,
      status: 'under_review',
      effective_date: new Date()
    });
    deliveredPolicyId = created._id;
  } catch (err) {
    logError('[marketplace] tenant Policy.create failed:', err?.message || err);
    purchase.delivery_status = 'failed';
    purchase.delivery_error = `policy.create: ${err?.message || err}`;
    await purchase.save();
    return { ok: false, error: err?.message || 'Policy create failed' };
  }

  // ── Kick off the policy approval workflow ────────────────────────
  const { workflowPending, workflowMessage } = await tryStartPolicyWorkflow({
    orgId: purchase.org_id,
    deliveredPolicyId,
    tenantConn
  });

  purchase.delivered_policy_id = deliveredPolicyId;
  purchase.delivery_status = 'delivered';
  purchase.delivery_error = workflowMessage;
  purchase.workflow_pending = workflowPending;
  await purchase.save();

  logInfo(`[marketplace] delivered policy ${policy._id} → tenant ${purchase.org_id} (Policy ${deliveredPolicyId}, workflow_pending=${workflowPending})`);
  return { ok: true, deliveredPolicyId, workflowPending, workflowMessage };
}

/**
 * Internal helper — try to start the policy approval workflow for an
 * already-delivered marketplace policy. Submitter is the org owner;
 * marketplace purchases happen outside any single user session
 * (webhook / reconcile / retry path) so we attribute to the
 * registered owner. If no workflow is configured we downgrade the
 * Policy to `draft` and return a friendly message; if it succeeds we
 * promote it to `under_review`.
 */
async function tryStartPolicyWorkflow({ orgId, deliveredPolicyId, tenantConn }) {
  let conn = tenantConn;
  try {
    if (!conn) conn = await getTenantConnection(orgId);
    const ownerDoc = await conn.collection('users').findOne(
      { is_org_owner: true },
      { projection: { _id: 1 } }
    );
    if (!ownerDoc?._id) {
      throw Object.assign(new Error('No org owner on file'), { code: 'NO_ORG_OWNER' });
    }
    const workflowService = new ApprovalWorkflowService(orgId);
    await workflowService.createPolicyApprovalRequest(deliveredPolicyId, ownerDoc._id);
    // Success — make sure the policy is in `under_review` (it may have
    // been left at `draft` by a previous attempt that fell back).
    try {
      const Policy = conn.model('Policy', policySchema);
      await Policy.updateOne({ _id: deliveredPolicyId }, { $set: { status: 'under_review' } });
    } catch (statusErr) {
      logError('[marketplace] policy status promote failed:', statusErr?.message || statusErr);
    }
    return { workflowPending: false, workflowMessage: '' };
  } catch (err) {
    const errCode = err?.code || '';
    const isNoWorkflow =
      err?.name === 'CastError' ||
      errCode === 'INVALID_ID' ||
      errCode === 'NO_APPROVAL_MATRIX' ||
      errCode === 'NO_MATCHING_RULE' ||
      errCode === 'WORKFLOW_NOT_CONFIGURED' ||
      errCode === 'NO_ORG_OWNER';

    if (isNoWorkflow) {
      try {
        const Policy = conn.model('Policy', policySchema);
        await Policy.updateOne({ _id: deliveredPolicyId }, { $set: { status: 'draft' } });
      } catch (downgradeErr) {
        logError('[marketplace] policy draft downgrade failed:', downgradeErr?.message || downgradeErr);
      }
      logWarn(`[marketplace] no policy workflow for ${orgId} — saved as draft`);
      return {
        workflowPending: true,
        workflowMessage: 'Policy saved as draft, hidden from other members. It will enter review automatically once an approval workflow for policies is configured (Role Permissions → Approval Workflows) and will publish when the review completes.'
      };
    }
    logError('[marketplace] policy workflow start failed:', err?.message || err);
    return {
      workflowPending: false,
      workflowMessage: `Policy delivered, but the approval workflow could not start automatically: ${err?.message || err}`
    };
  }
}

/**
 * Public helper — re-attempt the workflow start for a purchase whose
 * delivery succeeded but landed as `draft` because the tenant had no
 * approval workflow at that time. Idempotent: returns the current
 * state if there's nothing to retry (already in_progress, already
 * promoted, or not paid). Called from the marketplace detail page
 * when it loads with workflow_pending=true.
 */
export async function retryPolicyWorkflowForPurchase(purchaseId) {
  const { MarketplacePurchase } = getRouterModels();
  const purchase = await MarketplacePurchase.findById(purchaseId);
  if (!purchase) return { ok: false, error: 'Purchase not found' };
  if (purchase.delivery_status !== 'delivered' || !purchase.delivered_policy_id) {
    return { ok: false, error: 'Purchase not yet delivered', delivery_status: purchase.delivery_status };
  }
  if (!purchase.workflow_pending) {
    return { ok: true, workflowPending: false, workflowMessage: '', alreadyStarted: true };
  }

  const { workflowPending, workflowMessage } = await tryStartPolicyWorkflow({
    orgId: purchase.org_id,
    deliveredPolicyId: purchase.delivered_policy_id,
    tenantConn: null
  });

  purchase.workflow_pending = workflowPending;
  purchase.delivery_error = workflowMessage;
  await purchase.save();

  return {
    ok: true,
    deliveredPolicyId: purchase.delivered_policy_id,
    workflowPending,
    workflowMessage,
    workflowStarted: !workflowPending
  };
}

export default { deliverPurchase, retryPolicyWorkflowForPurchase };
