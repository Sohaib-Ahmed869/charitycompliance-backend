/**
 * publicMarketplaceDeliveryService — finalise a guest marketplace
 * purchase. Mirrors marketplaceDeliveryService but writes nothing to
 * a tenant DB. Output is a watermarked PDF stored on S3 under a
 * `_marketplace_public/` prefix; the buyer downloads it via the
 * claim-token endpoint.
 *
 * Inputs come from publicMarketplaceRoutes (the claim endpoint):
 *   • purchaseId  — MarketplacePublicPurchase _id
 *   • orgName     — string the buyer typed
 *   • logoBytes   — uploaded file buffer (optional)
 *   • logoMime    — uploaded file mime (optional)
 *   • policy      — already-loaded MarketplacePolicy doc (lean)
 *
 * The watermark layout is identical to the tenant flow (centered
 * logo + org name caption + separator line, no diagonal repeat) so
 * the deliverable looks the same regardless of where it was bought.
 */

import { uploadToS3, getFileStream } from './s3Service.js';
import { convertDocxBufferToPdfBuffer } from './docxToPdfService.js';
import { brandMarketplacePdf } from './policyPdfBrandingService.js';
import getRouterModels from '../db/models/routerModels.js';
import emailService from './emailService.js';
import { server as serverConfig } from '../config/index.js';
import { logError, logInfo } from '../utils/logger.js';

// ── helpers ─────────────────────────────────────────────────────────

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Watermarking lives in policyPdfBrandingService.js. Both this
// service and the tenant marketplace go through the same helper so
// the deliverable looks identical regardless of buy path.

// ── public API ──────────────────────────────────────────────────────

export async function deliverPublicPurchase({
  purchaseId,
  orgName,
  logoBytes,
  logoMime,
  policy
}) {
  const { MarketplacePublicPurchase } = getRouterModels();

  const sourceKey = policy?.file?.s3_key;
  if (!sourceKey) return { ok: false, error: 'Policy file missing.' };

  try {
    const stream = await getFileStream(sourceKey);
    const sourceBytes = await streamToBuffer(stream.Body);

    let pdfBytes = null;
    if (policy.file?.format === 'pdf') {
      pdfBytes = sourceBytes;
    } else {
      logInfo(`[public marketplace] converting DOCX → PDF for ${policy.title}`);
      pdfBytes = await convertDocxBufferToPdfBuffer(sourceBytes);
    }

    const watermarkedBytes = await brandMarketplacePdf(pdfBytes, {
      orgName,
      logoBytes,
      logoMime,
      policyTitle: policy.title,
      purchasedAt: new Date()
    });

    const baseName = (policy.file?.original_name || policy.title || 'policy').replace(/\.[^.]+$/, '');
    const deliveredFileName = `${baseName}.pdf`;
    const upload = await uploadToS3(
      watermarkedBytes,
      deliveredFileName,
      'application/pdf',
      '_marketplace_public',
      'policy-delivery'
    );

    await MarketplacePublicPurchase.findByIdAndUpdate(purchaseId, {
      $set: {
        status: 'claimed',
        delivery_status: 'delivered',
        delivery_error: '',
        delivered_s3_key: upload.key,
        delivered_file_name: deliveredFileName,
        buyer_org_name: String(orgName).slice(0, 200),
        claimed_at: new Date()
      }
    });

    logInfo(`[public marketplace] delivered ${policy._id} for purchase ${purchaseId}, size=${watermarkedBytes.length}b`);
    return { ok: true, deliveredFileName };
  } catch (err) {
    logError('[public marketplace] delivery failed:', err?.message || err);
    return { ok: false, error: err?.message || 'Delivery failed.' };
  }
}

/**
 * Send the buyer a download link they can use to re-fetch their PDF.
 * Best-effort — failures don't block the synchronous download.
 */
export async function sendPolicyDeliveryEmail({ to, orgName, policyTitle, claimToken, frontendBase }) {
  if (!to) return;
  const origin = (frontendBase || serverConfig.frontendUrl || '').replace(/\/$/, '');
  const downloadUrl = origin
    ? `${origin}/marketplace/claim/${encodeURIComponent(claimToken)}`
    : `(open the claim page from your receipt)`;

  const safeTitle = String(policyTitle || 'your policy').replace(/[<>]/g, '');
  const safeOrg = String(orgName || '').replace(/[<>]/g, '');

  const html = `
    <h2 style="margin:0 0 12px;">Your Stewardex policy is ready</h2>
    <p>Hi,</p>
    <p>Thanks for purchasing <strong>${safeTitle}</strong>. We've watermarked
       it with the organisation name <strong>${safeOrg}</strong> and your
       uploaded logo.</p>
    <p style="margin:18px 0;">
      <a href="${downloadUrl}"
         style="display:inline-block;padding:10px 18px;border-radius:6px;
                background:#0a2e3f;color:#fff;text-decoration:none;
                font-weight:bold;">
        Download your policy
      </a>
    </p>
    <p style="font-size:12px;color:#5b6770;">
      Keep this link safe — it's the only way to re-download this
      copy. Anyone with the link can download it, so don't share it.
    </p>
  `.trim();

  return emailService.sendEmail({
    to,
    subject: `Your Stewardex policy: ${safeTitle}`,
    html
  });
}

export default { deliverPublicPurchase, sendPolicyDeliveryEmail };
