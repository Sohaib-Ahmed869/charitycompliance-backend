/**
 * approvalZipExportService — assembles an audit-grade ZIP archive of
 * approval workflows, streamed straight to the HTTP response so we
 * never buffer the whole thing in memory.
 *
 * Layout
 * ──────
 *   README.txt                       describes the archive + filters used
 *   all-workflows.csv                one row per workflow (summary)
 *   workflows/
 *     YYYY/MM/                       date-organised by submission month
 *       WF-<id>__<request_type>__<submitter-slug>/
 *         workflow.json              full Mongoose doc snapshot
 *         timeline.csv               each approval step with timestamps
 *         comments.csv               every comment (steps + reviews)
 *         attachments/               every S3-backed file pulled inline
 *           <original-filename>
 *
 * The caller owns the HTTP response; we just `pipe()` the archiver
 * output into it. Failures on individual attachments are swallowed
 * (and noted in README) so a single missing S3 object doesn't poison
 * the whole export.
 */

import archiver from 'archiver';
import mongoose from 'mongoose';
import puppeteer from 'puppeteer';
import { getFileStream, uploadToS3 } from './s3Service.js';
import { generateApprovalPDF } from './approvalPdfService.js';
import approvalPdfCacheSchema from '../db/schemas/platform/approvalPdfCacheSchema.js';
import { logError, logInfo } from '../utils/logger.js';

// ── entity_type → raw collection map ────────────────────────────────
// Mirrors the resolver in approvalController.listApprovalRequests. We
// pull the entity straight off the raw Mongo collection so we don't
// need to register every domain schema on the tenant connection.
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

/** Batch-fetch entities keyed by `${entity_type}:${entity_id}`. */
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
      for (const d of docs) {
        map.set(`${type}:${d._id.toString()}`, d);
      }
    } catch (err) {
      // Tenant may not have this collection — skip silently.
      logError(`[zip] entity fetch failed for ${type}:`, err?.message || err);
    }
  }));
  return map;
}

// ── Concurrency primitive ───────────────────────────────────────────
// A tiny p-limit replacement so we don't add a new dep. Spins `limit`
// workers that pull items from a shared cursor — keeps memory bounded
// (only `limit` jobs in flight) without a queue or external library.
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

// Tuneables. Fresh Puppeteer renders are CPU+memory bound — capped at
// 2 to stay safe on low-RAM hosts (Render free tier ~512MB). Cache
// reads + attachment fetches are I/O-bound and can run wider.
const RENDER_CONCURRENCY = 2;
const CACHE_READ_CONCURRENCY = 8;
const ATTACHMENT_CONCURRENCY = 5;

// Bump this whenever the PDF renderer changes shape (new sections,
// curated entity fields, layout tweaks). Cached PDFs with a mismatched
// template_version are treated as stale and re-rendered.
const PDF_TEMPLATE_VERSION = 'v3-full-audit-trail';

// ── helpers ─────────────────────────────────────────────────────────

/** Collect an S3 (or any) readable stream into a Buffer. */
function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data',  (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    readable.on('end',   () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

/** Make a filename / folder segment safe for any OS: strip slashes,
 *  collapse whitespace, trim length. */
function safeSegment(s, fallback = 'untitled') {
  const cleaned = String(s ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/** "Aisha Khan" → "aisha-khan". Used for folder naming. */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'unknown';
}

/** ISO timestamp or '—' for safe display. */
const ts = (d) => (d ? new Date(d).toISOString() : '');

/** CSV escape — quote on quotes/commas/newlines. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

/** Best-effort actor formatter from a populated user doc. */
function actorName(u) {
  if (!u) return '';
  const first = u.first_name || u.firstName || '';
  const last  = u.last_name  || u.lastName  || '';
  const full  = `${first} ${last}`.trim();
  return full || u.email || u.fullName || '';
}

/** Friendly request-type label — falls back to the raw key. */
function humaniseType(t) {
  if (!t) return '';
  return String(t).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Walks the schema and returns every file with an S3 key.
 *  Each entry is { source, key, name, file_type, size }. */
function collectAttachments(approval) {
  const out = [];
  const push = (source, files) => {
    if (!Array.isArray(files)) return;
    files.forEach((f, i) => {
      if (!f) return;
      const key = f.key || (typeof f === 'string' ? f : null);
      if (!key) return;
      out.push({
        source,
        key,
        name: f.name || `${source}-${i + 1}`,
        file_type: f.file_type || '',
        size: f.size || 0
      });
    });
  };

  (approval.approval_steps || []).forEach((step, i) => {
    push(`step-${i + 1}-ack`, step.acknowledgement_files);
    // step.attachments is a legacy string[] of S3 keys
    if (Array.isArray(step.attachments)) {
      step.attachments.forEach((key, j) => {
        if (typeof key === 'string' && key) {
          out.push({
            source: `step-${i + 1}-attachment`,
            key,
            name: key.split('/').pop() || `attachment-${j + 1}`,
            file_type: '',
            size: 0
          });
        }
      });
    }
  });
  push('sweep-funds-receipts', approval?.sweep_funds?.receipt_files);
  (approval.rejection_reviews || []).forEach((rr, i) => {
    push(`rejection-review-${i + 1}`, rr.rejection_files);
  });

  return out;
}

// ── builders ────────────────────────────────────────────────────────

function buildReadme({ generatedAt, orgId, filters, count, missingAttachments, failedPdfs, cacheStats }) {
  const lines = [];
  lines.push('Stewardex — Approval Workflow Export');
  lines.push('====================================');
  lines.push('');
  lines.push(`Generated:   ${generatedAt.toISOString()}`);
  lines.push(`Organisation: ${orgId}`);
  lines.push(`Workflows:   ${count}`);
  if (cacheStats) {
    lines.push(`Render path: ${cacheStats.hit} cached + ${cacheStats.miss} freshly rendered`);
  }
  lines.push('');
  lines.push('Filters applied');
  lines.push('---------------');
  const lines2 = Object.entries(filters || {})
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  lines.push(lines2.length ? lines2.join('\n') : '  (no filters — full register)');
  lines.push('');
  lines.push('Archive layout');
  lines.push('--------------');
  lines.push('  all-workflows.csv         — summary index, one row per workflow');
  lines.push('  workflows/YYYY/MM/<id>/   — one folder per workflow:');
  lines.push('      workflow.pdf          — the audit document. Includes the entity');
  lines.push('                              (policy / expense / risk / donor / …),');
  lines.push('                              every approval step with timestamps + actor,');
  lines.push('                              every comment, every signature.');
  lines.push('      attachments/          — every file referenced by the workflow,');
  lines.push('                              pulled inline.');
  lines.push('');
  if (failedPdfs?.length) {
    lines.push(`Note: ${failedPdfs.length} workflow PDF(s) could not be rendered. The`);
    lines.push('JSON snapshot and CSVs still carry the full data — use those for audit if needed.');
    failedPdfs.forEach((f) => {
      lines.push(`  • ${f.workflow}: ${f.error}`);
    });
    lines.push('');
  }
  if (missingAttachments?.length) {
    lines.push(`Note: ${missingAttachments.length} attachment(s) could not be fetched from storage`);
    lines.push('and have been skipped. Their metadata is still present in workflow.json.');
    lines.push('');
  }
  lines.push('This archive is the source-of-truth audit pack for these workflows.');
  lines.push('Hash the ZIP (sha256) and pin the hash if you need tamper-evident retention.');
  return lines.join('\n');
}

function buildAllWorkflowsCsv(approvals) {
  const headers = [
    'workflow_id', 'matrix_name', 'category', 'request_type', 'entity_type', 'entity_id',
    'status', 'amount', 'submitted_by', 'submitted_at', 'completed_at',
    'step_count', 'approved_steps', 'rejected_steps', 'pending_steps',
    'attachment_count', 'last_updated_at'
  ];
  const rows = approvals.map((a) => {
    const steps = a.approval_steps || [];
    const approved = steps.filter((s) => s.status === 'approved').length;
    const rejected = steps.filter((s) => s.status === 'rejected').length;
    const pending  = steps.filter((s) => s.status === 'pending').length;
    return csvRow([
      a._id?.toString() || '',
      a.approval_matrix_id?.name || '',
      humaniseType(a.request_type) || '',
      a.request_type || '',
      a.entity_type || '',
      a.entity_id?.toString() || '',
      a.status || '',
      a.amount == null ? '' : a.amount,
      actorName(a.submitted_by),
      ts(a.created_at),
      ts(a.completed_at),
      steps.length,
      approved,
      rejected,
      pending,
      collectAttachments(a).length,
      ts(a.updatedAt || a.updated_at)
    ]);
  });
  return [csvRow(headers), ...rows].join('\r\n');
}

function buildTimelineCsv(approval) {
  const headers = ['level', 'approver_name', 'position', 'department', 'status',
    'approved_at', 'rejected_at', 'rejection_reason', 'comments', 'has_signature', 'attachment_count'];
  const rows = (approval.approval_steps || []).map((s) => csvRow([
    s.level ?? '',
    actorName(s.approver_user_id),
    s.approver_position_id?.name || s.approver_position_id?.title || '',
    s.approver_department_id?.name || '',
    s.status || '',
    ts(s.approved_at),
    ts(s.rejected_at),
    s.rejection_reason || '',
    s.comments || '',
    s.signature_data ? 'yes' : 'no',
    (s.acknowledgement_files?.length || 0) + (s.attachments?.length || 0)
  ]));
  return [csvRow(headers), ...rows].join('\r\n');
}

function buildCommentsCsv(approval) {
  const headers = ['source', 'level', 'author', 'timestamp', 'comment'];
  const rows = [];
  (approval.approval_steps || []).forEach((s) => {
    if (s.comments) {
      rows.push(csvRow(['step', s.level ?? '', actorName(s.approver_user_id), ts(s.approved_at || s.rejected_at), s.comments]));
    }
    if (s.rejection_reason) {
      rows.push(csvRow(['rejection', s.level ?? '', actorName(s.approver_user_id), ts(s.rejected_at), s.rejection_reason]));
    }
    if (s.acknowledgement_note) {
      rows.push(csvRow(['acknowledgement', s.level ?? '', actorName(s.approver_user_id), ts(s.approved_at), s.acknowledgement_note]));
    }
  });
  (approval.rejection_reviews || []).forEach((rr) => {
    if (rr.rejection_comments) {
      rows.push(csvRow(['rejection-review', rr.step_index ?? '', actorName(rr.rejected_by), ts(rr.created_at), rr.rejection_comments]));
    }
    if (rr.review_comments) {
      rows.push(csvRow(['rejection-review-response', rr.step_index ?? '', actorName(rr.forwarded_to), ts(rr.reviewed_at), rr.review_comments]));
    }
  });
  (approval.escalations || []).forEach((e) => {
    if (e.request_comments) {
      rows.push(csvRow(['escalation-request', e.step_index ?? '', actorName(e.escalated_by), ts(e.created_at), e.request_comments]));
    }
    if (e.comments) {
      rows.push(csvRow(['escalation-response', e.step_index ?? '', actorName(e.escalated_to), ts(e.responded_at), e.comments]));
    }
  });
  return [csvRow(headers), ...rows].join('\r\n');
}

function workflowFolderPath(approval) {
  const createdAt = approval.created_at ? new Date(approval.created_at) : new Date();
  const yyyy = createdAt.getUTCFullYear();
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0');

  const idSuffix = (approval._id?.toString() || '').slice(-6) || 'wf';
  const wfNo = `WF-${yyyy}-${idSuffix}`;
  const type = slugify(approval.request_type || 'workflow');
  const submitter = slugify(actorName(approval.submitted_by) || 'unknown');
  return `workflows/${yyyy}/${mm}/${wfNo}__${type}__${submitter}`;
}

// ── main entry point ────────────────────────────────────────────────

/**
 * Streams a ZIP of the provided approvals into `res`.
 * `approvals` must already be populated with submitted_by + approval_matrix_id + step approvers
 * so the labels render cleanly without follow-up queries.
 *
 * `orgLogoUrl` is the tenant's logo (Organization.logo_url) — embedded
 * in every per-workflow PDF header so the audit pack looks like
 * official org-branded paperwork.
 *
 * `tenantDb` is required for the per-workflow PDF cache lookup — when
 * a workflow hasn't changed since its last render we reuse the cached
 * PDF from S3 instead of spending another Puppeteer cycle. Pass the
 * same connection the caller used to fetch `approvals`.
 */
export async function streamApprovalsZip(approvals, res, { orgId, filters, orgLogoUrl = '', tenantDb = null }) {
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') logError('[zip] archiver warning:', err);
  });
  archive.on('error', (err) => {
    logError('[zip] archiver error:', err);
    // After headers are written we can't really recover — abort the
    // response and let the client surface a network error.
    try { res.destroy(err); } catch { /* swallow */ }
  });

  archive.pipe(res);

  const missingAttachments = [];
  const failedPdfs = [];
  const cacheStats = { hit: 0, miss: 0 };

  // Top-level summary CSV first — fast, no I/O.
  archive.append(buildAllWorkflowsCsv(approvals), { name: 'all-workflows.csv' });

  // ── PDF cache lookup ────────────────────────────────────────────
  // For each workflow we check ApprovalPdfCache: if the cached entry's
  // source_updated_at is ≥ the workflow's updatedAt, the cached PDF on
  // S3 is still fresh and we skip the Puppeteer render entirely. This
  // makes repeat exports near-instant — only changed workflows pay the
  // render cost.
  let PdfCache = null;
  if (tenantDb) {
    PdfCache = tenantDb.models.ApprovalPdfCache
      || tenantDb.model('ApprovalPdfCache', approvalPdfCacheSchema);
  }

  const cacheRows = PdfCache
    ? await PdfCache.find({ workflow_id: { $in: approvals.map((a) => a._id) } }).lean()
    : [];
  const cacheByWorkflow = Object.fromEntries(cacheRows.map((r) => [r.workflow_id.toString(), r]));

  // Batch-fetch the underlying entity (policy / risk / expense / etc.)
  // for each workflow so the per-workflow PDF can include its details.
  const entityMap = await fetchEntitiesByWorkflow(tenantDb, approvals);

  // Compute the work plan: for each workflow either "reuse cached"
  // (download from S3) or "render fresh" (puppeteer).
  // Cache freshness factors in BOTH the approval's updatedAt and the
  // entity's updatedAt — editing a linked policy invalidates the
  // cached PDF even if the approval itself wasn't touched.
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
      // Template-version match — a renderer change automatically
      // invalidates cached PDFs without needing to wipe the collection.
      && (cached.template_version || 'v1') === PDF_TEMPLATE_VERSION;
    return { approval: a, entity, cached: isFresh ? cached : null, sourceUpdatedAt };
  });

  // ── Shared Puppeteer browser — only launch if we actually need it ─
  // If every workflow has a fresh cached PDF we can skip Chromium
  // entirely and the export becomes pure I/O against S3.
  const needsRender = workItems.some((w) => !w.cached);
  let sharedBrowser = null;
  if (needsRender) {
    try {
      sharedBrowser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    } catch (err) {
      logError('[zip] could not launch Chromium for batched PDFs:', err?.message || err);
    }
  }

  try {
    // ── Per-workflow pipeline ──────────────────────────────────────
    // Concurrency-capped. PDFs are CPU+memory heavy (cap 2) while
    // attachment fetches are I/O (cap 5 per workflow). Top-level
    // Outer concurrency stays at RENDER_CONCURRENCY because any item
    // may hit the slow path (Puppeteer). Cache hits still benefit
    // from the parallel attachment fetches per workflow.
    await mapWithConcurrency(workItems, RENDER_CONCURRENCY, async ({ approval, entity, cached, sourceUpdatedAt }) => {
      const folder = workflowFolderPath(approval);

      // ── 1. Per-workflow PDF (cache hit vs miss) ──
      let pdfBuffer = null;
      if (cached) {
        // Cache hit — stream the cached PDF from S3 once.
        try {
          const s3 = await getFileStream(cached.s3_key);
          pdfBuffer = await streamToBuffer(s3.Body);
          cacheStats.hit++;
        } catch (err) {
          // Cached entry pointed at a missing S3 key — fall through
          // and re-render. Don't surface this to the auditor; just
          // log + recover.
          logError(`[zip] cached PDF unreadable for ${approval._id} (${cached.s3_key}):`, err?.message || err);
          pdfBuffer = null;
        }
      }
      if (!pdfBuffer) {
        try {
          // Pass the entity through as a generic param so the PDF
          // generator can render entity details inline (policy fields,
          // expense breakdown, risk scoring, etc.).
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
          pdfBuffer = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);
          cacheStats.miss++;

          // Persist to the cache for next time. Failure here is
          // non-fatal — we still ship the PDF this run, just no cache
          // for next.
          if (PdfCache) {
            try {
              const cacheKey = `_approval-pdf-cache/${orgId}/${approval._id}.pdf`;
              const upload = await uploadToS3(pdfBuffer, `${approval._id}.pdf`, 'application/pdf', orgId, 'approval-pdf-cache');
              await PdfCache.findOneAndUpdate(
                { workflow_id: approval._id },
                {
                  $set: {
                    s3_key: upload.key || cacheKey,
                    bytes: pdfBuffer.length,
                    source_updated_at: sourceUpdatedAt || new Date(),
                    template_version: PDF_TEMPLATE_VERSION,
                    generated_at: new Date()
                  }
                },
                { upsert: true }
              );
            } catch (cacheErr) {
              logError(`[zip] cache save failed for ${approval._id}:`, cacheErr?.message || cacheErr);
            }
          }
        } catch (err) {
          const detail = err?.message || err?.toString?.() || String(err);
          const stack = err?.stack ? `\n${err.stack.split('\n').slice(0, 5).join('\n')}` : '';
          // eslint-disable-next-line no-console
          console.error(`[zip] PDF generation failed for ${approval._id}: ${detail}${stack}`);
          logError(`[zip] PDF generation failed for ${approval._id}: ${detail}`);
          failedPdfs.push({ workflow: approval._id?.toString(), error: detail });
        }
      }
      if (pdfBuffer) archive.append(pdfBuffer, { name: `${folder}/workflow.pdf` });

      // The workflow PDF now carries all the timeline + comments +
      // entity detail an auditor needs. No more per-workflow CSV/JSON
      // companions — the top-level all-workflows.csv is the single
      // structured-data index.

      // ── 2. Attachments (parallel within the workflow) ──
      const attachments = collectAttachments(approval);
      const attBuffers = await mapWithConcurrency(attachments, ATTACHMENT_CONCURRENCY, async (att) => {
        try {
          const s3 = await getFileStream(att.key);
          const bytes = await streamToBuffer(s3.Body);
          return { att, bytes, err: null };
        } catch (err) {
          return { att, bytes: null, err };
        }
      });
      for (const { att, bytes, err } of attBuffers) {
        if (err || !bytes) {
          logError(`[zip] could not fetch attachment ${att.key}:`, err?.message || err);
          missingAttachments.push({ workflow: approval._id?.toString(), key: att.key, name: att.name });
          continue;
        }
        const filename = `${att.source}__${safeSegment(att.name, 'attachment')}`;
        archive.append(bytes, { name: `${folder}/attachments/${filename}` });
      }
    });
  } finally {
    if (sharedBrowser) await sharedBrowser.close().catch(() => {});
  }

  // README last so missingAttachments / failedPdfs / cacheStats are accurate.
  archive.append(buildReadme({
    generatedAt: new Date(),
    orgId,
    filters,
    count: approvals.length,
    missingAttachments,
    failedPdfs,
    cacheStats
  }), { name: 'README.txt' });

  await archive.finalize();
  logInfo(`[zip] approvals export streamed: ${approvals.length} workflows, ${cacheStats.hit} cache hits, ${cacheStats.miss} fresh renders, ${missingAttachments.length} missing attachments, ${failedPdfs.length} PDF failures`);
}

export default { streamApprovalsZip };
