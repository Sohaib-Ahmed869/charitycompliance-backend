/**
 * approvalMergedPdfService — produces a SINGLE PDF containing every
 * matching workflow's full audit page, back-to-back. Same per-workflow
 * content as the ZIP export's workflow.pdf entries, just merged via
 * pdf-lib into one downloadable document.
 *
 * Pipeline:
 *   1. For each workflow, resolve the audit PDF buffer:
 *        • Cache hit  → pull bytes from S3
 *        • Cache miss → render with Puppeteer (shared browser),
 *                       upload + upsert the cache row
 *   2. Merge all buffers with pdf-lib into a single PDFDocument.
 *   3. Stream the merged bytes back to the response.
 *
 * Sharing the cache with the ZIP exporter means a fresh "Export PDF"
 * right after an "Export ZIP" is near-instant — both consume the same
 * per-workflow cache rows.
 */

import mongoose from 'mongoose';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { getFileStream, uploadToS3 } from './s3Service.js';
import { generateApprovalPDF } from './approvalPdfService.js';
import approvalPdfCacheSchema from '../db/schemas/platform/approvalPdfCacheSchema.js';
import { logError, logInfo } from '../utils/logger.js';

// Match the ZIP service's tuning so the cache stays interchangeable.
// We use TWO limits: a tight 2 for fresh Puppeteer renders (CPU+memory
// bound) and a looser 8 for cache-hit S3 reads (I/O bound). The
// previous unified limit of 2 throttled the fast path unnecessarily.
const RENDER_CONCURRENCY = 2;
const CACHE_READ_CONCURRENCY = 8;
const PDF_TEMPLATE_VERSION = 'v3-full-audit-trail';

// Entity_type → raw collection. Mirrored from the ZIP service so we
// don't tangle the two files via a shared import that drags every
// dependency along; a small duplicated map is the better tradeoff
// here than a fragile cross-service helper.
const ENTITY_COLLECTIONS = {
  risk:                 'risks',
  policy:               'policies',
  expense:              'expenses',
  project:              'projects_register',
  funding_agreement:    'funding_agreements',
  donor:                'donors',
  donation:             'donations',
  donation_agreement:   'donation_agreements',
  donation_milestone:   'donation_milestones',
  grant:                'grants',
  complaint:            'complaints',
  coi:                  'coi_declarations',
  partner_vetting:      'partner_vettings',
  social_media_campaign:'social_media_campaigns',
  sweep_funds:          'sweep_funds_requests',
  donor_refund:         'donor_refunds',
  contract:             'contracts',
  meeting:              'meetings',
  purchase:             'purchase_requests',
  training:             'training_programs'
};

// ── helpers ─────────────────────────────────────────────────────────

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data',  (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    readable.on('end',   () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function fetchEntitiesByWorkflow(tenantDb, approvals) {
  if (!tenantDb || !approvals?.length) return new Map();
  const byType = new Map();
  for (const a of approvals) {
    const t = String(a.entity_type || '').toLowerCase();
    const idStr = a.entity_id?._id?.toString?.() || a.entity_id?.toString?.();
    if (!t || !idStr || !ENTITY_COLLECTIONS[t]) continue;
    if (!byType.has(t)) byType.set(t, new Set());
    byType.get(t).add(idStr);
  }
  const map = new Map();
  await Promise.all(Array.from(byType.entries()).map(async ([type, idSet]) => {
    try {
      const coll = tenantDb.collection(ENTITY_COLLECTIONS[type]);
      const ids = Array.from(idSet).map((s) => {
        try { return new mongoose.Types.ObjectId(s); } catch { return null; }
      }).filter(Boolean);
      if (!ids.length) return;
      const docs = await coll.find({ _id: { $in: ids } }).toArray();
      for (const d of docs) map.set(`${type}:${d._id.toString()}`, d);
    } catch (err) {
      logError(`[merged-pdf] entity fetch failed for ${type}:`, err?.message || err);
    }
  }));
  return map;
}

// ── main entry point ────────────────────────────────────────────────

/**
 * Streams a SINGLE merged PDF of every workflow's audit page into `res`.
 */
export async function streamApprovalsMergedPdf(approvals, res, { orgId, orgLogoUrl = '', tenantDb = null }) {
  const cacheStats = { hit: 0, miss: 0 };
  const failedPdfs = [];

  // Cache lookups + entity prefetch (same shape as the ZIP service).
  const PdfCache = tenantDb
    ? (tenantDb.models.ApprovalPdfCache || tenantDb.model('ApprovalPdfCache', approvalPdfCacheSchema))
    : null;
  const cacheRows = PdfCache
    ? await PdfCache.find({ workflow_id: { $in: approvals.map((a) => a._id) } }).lean()
    : [];
  const cacheByWorkflow = Object.fromEntries(cacheRows.map((r) => [r.workflow_id.toString(), r]));
  const entityMap = await fetchEntitiesByWorkflow(tenantDb, approvals);

  const workItems = approvals.map((a) => {
    const wfId = a._id.toString();
    const cached = cacheByWorkflow[wfId];
    const entityKey = `${String(a.entity_type || '').toLowerCase()}:${a.entity_id?._id?.toString?.() || a.entity_id?.toString?.() || ''}`;
    const entity = entityMap.get(entityKey) || null;
    const aTs = new Date(a.updatedAt || a.updated_at || a.created_at || 0).getTime();
    const eTs = new Date(entity?.updatedAt || entity?.updated_at || 0).getTime();
    const sourceUpdatedAt = new Date(Math.max(aTs, eTs));
    const isFresh = cached
      && cached.source_updated_at
      && new Date(cached.source_updated_at) >= sourceUpdatedAt
      && (cached.template_version || 'v1') === PDF_TEMPLATE_VERSION;
    return { approval: a, entity, cached: isFresh ? cached : null, sourceUpdatedAt };
  });

  // Split the work into two buckets so each can run with its own
  // concurrency cap. Cache reads are I/O so we can run many in
  // parallel; fresh renders are heavy and stay capped at 2.
  const cacheHits     = workItems.filter((w) => w.cached);
  const renderNeeded  = workItems.filter((w) => !w.cached);
  const resultsById = new Map(); // _id → { approval, buf, err }

  // ── Fast path: cache hits in parallel ───────────────────────────
  await mapWithConcurrency(cacheHits, CACHE_READ_CONCURRENCY, async (item) => {
    try {
      const s3 = await getFileStream(item.cached.s3_key);
      const buf = await streamToBuffer(s3.Body);
      cacheStats.hit++;
      resultsById.set(item.approval._id.toString(), { approval: item.approval, buf, err: null });
    } catch (err) {
      logError(`[merged-pdf] cache read failed for ${item.approval._id}:`, err?.message || err);
      // Promote to render-needed so we still produce a PDF for this workflow.
      renderNeeded.push(item);
    }
  });

  // ── Slow path: fresh renders (only if anything actually needs one) ─
  let sharedBrowser = null;
  if (renderNeeded.length) {
    try {
      sharedBrowser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    } catch (err) {
      logError('[merged-pdf] could not launch Chromium:', err?.message || err);
    }

    await mapWithConcurrency(renderNeeded, RENDER_CONCURRENCY, async ({ approval, entity, sourceUpdatedAt }) => {
      try {
        const pdfResult = await generateApprovalPDF(
          approval, null, null, orgLogoUrl, null,
          {
            ...(sharedBrowser ? { browser: sharedBrowser } : {}),
            waitUntil: 'load',
            timeout: 15000,
            entity,
            entityType: approval.entity_type
          }
        );
        const buf = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);
        cacheStats.miss++;

        // Persist to cache so the next "Export PDF" / "Export ZIP" run
        // doesn't re-render this workflow.
        if (PdfCache) {
          try {
            const upload = await uploadToS3(buf, `${approval._id}.pdf`, 'application/pdf', orgId, 'approval-pdf-cache');
            await PdfCache.findOneAndUpdate(
              { workflow_id: approval._id },
              { $set: {
                  s3_key: upload.key,
                  bytes: buf.length,
                  source_updated_at: sourceUpdatedAt || new Date(),
                  template_version: PDF_TEMPLATE_VERSION,
                  generated_at: new Date()
                } },
              { upsert: true }
            );
          } catch (cacheErr) {
            logError(`[merged-pdf] cache save failed for ${approval._id}:`, cacheErr?.message || cacheErr);
          }
        }
        resultsById.set(approval._id.toString(), { approval, buf, err: null });
      } catch (err) {
        const detail = err?.message || String(err);
        logError(`[merged-pdf] render failed for ${approval._id}: ${detail}`);
        failedPdfs.push({ workflow: approval._id?.toString(), error: detail });
        resultsById.set(approval._id.toString(), { approval, buf: null, err });
      }
    });
  }

  if (sharedBrowser) await sharedBrowser.close().catch(() => {});

  // Restore the original approvals order (newest-first) regardless of
  // which path each one took.
  const buffers = approvals.map((a) => resultsById.get(a._id.toString()) || { approval: a, buf: null });

  // ── Merge via pdf-lib ──────────────────────────────────────────
  const merged = await PDFDocument.create();
  for (const { approval, buf } of buffers) {
    if (!buf) continue;
    try {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
    } catch (err) {
      logError(`[merged-pdf] could not splice ${approval._id} into merged doc:`, err?.message || err);
    }
  }

  // If nothing was renderable, surface an empty-but-valid PDF so
  // the client still gets a file (saner than a half-streamed response).
  if (merged.getPageCount() === 0) {
    const blank = merged.addPage();
    const { width, height } = blank.getSize();
    blank.drawText('No workflows could be rendered for this export.', {
      x: 50, y: height - 100, size: 14
    });
  }

  const out = await merged.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(out.length));
  res.end(Buffer.from(out));

  logInfo(`[merged-pdf] approvals merged-PDF: ${approvals.length} workflows, ${cacheStats.hit} cache hits, ${cacheStats.miss} fresh renders, ${failedPdfs.length} failures, output ${out.length} bytes`);
}

export default { streamApprovalsMergedPdf };
