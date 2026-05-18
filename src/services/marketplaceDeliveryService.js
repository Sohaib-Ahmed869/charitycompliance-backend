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

import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import { uploadToS3, getFileStream } from './s3Service.js';
import { getTenantConnection } from '../db/connectionManager.js';
import getRouterModels from '../db/models/routerModels.js';
import organizationSchema from '../db/schemas/platform/organizationSchema.js';
import policySchema from '../db/schemas/platform/policySchema.js';
import { logError, logInfo } from '../utils/logger.js';

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

/** Turn a data: URL or http URL into PNG/JPG bytes pdf-lib can embed. */
async function fetchLogoBytes(logoUrl) {
  if (!logoUrl) return null;
  const raw = String(logoUrl).trim();
  if (!raw) return null;

  if (raw.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(raw);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const bytes = Buffer.from(match[2], 'base64');
    return { bytes, mime };
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const r = await fetch(raw);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = (r.headers.get('content-type') || '').toLowerCase();
      return { bytes: buf, mime };
    } catch (err) {
      logError('[marketplace] logo fetch failed:', err?.message || err);
      return null;
    }
  }
  return null;
}

/**
 * Watermark a PDF buffer:
 *   • top-right header rectangle with the org logo (if available)
 *     and org name text
 *   • diagonal "Licensed to <Org Name>" pattern across each page in
 *     low opacity so screenshots remain traceable but reading is
 *     unaffected
 */
async function watermarkPdf(pdfBytes, { orgName, logoBytes, logoMime }) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  let logoImage = null;
  if (logoBytes && logoMime) {
    try {
      if (logoMime.includes('png')) {
        logoImage = await doc.embedPng(logoBytes);
      } else if (logoMime.includes('jpeg') || logoMime.includes('jpg')) {
        logoImage = await doc.embedJpg(logoBytes);
      }
    } catch (err) {
      // Logo embed can fail on unusual formats; fall back to text-only.
      logError('[marketplace] logo embed failed:', err?.message || err);
    }
  }

  const safeOrgName = String(orgName || 'Licensed organisation').slice(0, 80);
  const diagonalLabel = `Licensed to ${safeOrgName}`;

  const pages = doc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();

    // ── Header band — logo + org name in the top-right ──────────────
    const headerH = 36;
    const padding = 18;
    page.drawRectangle({
      x: 0,
      y: height - headerH,
      width,
      height: headerH,
      color: rgb(0.043, 0.149, 0.224), // brand deep navy
      opacity: 0.92
    });

    // Org name (right-aligned)
    const nameSize = 11;
    const nameWidth = font.widthOfTextAtSize(safeOrgName, nameSize);
    page.drawText(safeOrgName, {
      x: width - padding - nameWidth,
      y: height - headerH + (headerH - nameSize) / 2 + 1,
      size: nameSize,
      font,
      color: rgb(1, 1, 1)
    });

    // Logo on the left of the header band (if we have one)
    if (logoImage) {
      const targetH = headerH - 12;
      const scale = targetH / logoImage.height;
      const logoW = logoImage.width * scale;
      page.drawImage(logoImage, {
        x: padding,
        y: height - headerH + (headerH - targetH) / 2,
        width: logoW,
        height: targetH
      });
    } else {
      // No logo — fall back to "Stewardex" wordmark text on the left.
      page.drawText('Stewardex', {
        x: padding,
        y: height - headerH + (headerH - 11) / 2 + 1,
        size: 11,
        font,
        color: rgb(0.302, 0.702, 0.659) // brand-teal
      });
    }

    // ── Diagonal repeated watermark ────────────────────────────────
    const wmSize = 22;
    const wmColor = rgb(0.043, 0.149, 0.224);
    const wmOpacity = 0.08;
    const spacingY = 130;
    const spacingX = 320;

    for (let y = -spacingY; y < height + spacingY; y += spacingY) {
      for (let x = -spacingX; x < width + spacingX; x += spacingX) {
        page.drawText(diagonalLabel, {
          x,
          y,
          size: wmSize,
          font,
          color: wmColor,
          opacity: wmOpacity,
          rotate: degrees(-28)
        });
      }
    }
  }

  return Buffer.from(await doc.save());
}

/**
 * deliverPurchase — main entry point. Idempotent: safe to call twice.
 * Returns { ok: true, deliveredPolicyId } on success; { ok: false, error }
 * otherwise.
 */
export async function deliverPurchase(purchaseId) {
  const { MarketplacePurchase, MarketplacePolicy } = getRouterModels();
  const purchase = await MarketplacePurchase.findById(purchaseId);
  if (!purchase) return { ok: false, error: 'Purchase not found' };
  if (purchase.status !== 'paid') return { ok: false, error: 'Purchase not paid' };
  if (purchase.delivery_status === 'delivered' && purchase.delivered_policy_id) {
    return { ok: true, deliveredPolicyId: purchase.delivered_policy_id };
  }

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

    if (policy.file?.format === 'pdf') {
      // Embed logo (if any) + watermark.
      const logo = orgLogoUrl ? await fetchLogoBytes(orgLogoUrl) : null;
      watermarkedBytes = await watermarkPdf(sourceBytes, {
        orgName: orgDisplayName,
        logoBytes: logo?.bytes,
        logoMime: logo?.mime
      });
      watermarkedMime = 'application/pdf';
      originalName = (policy.file?.original_name || policy.title || 'policy').replace(/\.pdf$/i, '') + '.pdf';
    } else {
      // DOCX path — pdf-lib can't manipulate DOCX. Pass the source
      // through unchanged but still register it in the tenant's
      // policy library so the org gets their copy.
      watermarkedBytes = sourceBytes;
      watermarkedMime = policy.file?.mime_type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      originalName = policy.file?.original_name || `${policy.title}.docx`;
    }

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
  // We default to status:'active' so it shows up in the org's main
  // /policies list immediately. They can edit cycle/owner later.
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
      status: 'active',
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

  purchase.delivered_policy_id = deliveredPolicyId;
  purchase.delivery_status = 'delivered';
  purchase.delivery_error = '';
  await purchase.save();

  logInfo(`[marketplace] delivered policy ${policy._id} → tenant ${purchase.org_id} (Policy ${deliveredPolicyId})`);
  return { ok: true, deliveredPolicyId };
}

export default { deliverPurchase };
