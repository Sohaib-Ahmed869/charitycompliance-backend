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
import puppeteer from 'puppeteer';
import { getFileStream } from './s3Service.js';
import { generateApprovalPDF } from './approvalPdfService.js';
import { logError, logInfo } from '../utils/logger.js';

// ── helpers ─────────────────────────────────────────────────────────

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

function buildReadme({ generatedAt, orgId, filters, count, missingAttachments, failedPdfs }) {
  const lines = [];
  lines.push('Stewardex — Approval Workflow Export');
  lines.push('====================================');
  lines.push('');
  lines.push(`Generated:   ${generatedAt.toISOString()}`);
  lines.push(`Organisation: ${orgId}`);
  lines.push(`Workflows:   ${count}`);
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
  lines.push('  all-workflows.csv         — summary row per workflow');
  lines.push('  workflows/YYYY/MM/<id>/   — one folder per workflow:');
  lines.push('      workflow.pdf          — human-readable audit document (the main file)');
  lines.push('      timeline.csv          — every step, decision, actor, timestamp');
  lines.push('      comments.csv          — every comment across steps + reviews');
  lines.push('      workflow.json         — full Mongoose snapshot for tooling');
  lines.push('      attachments/          — all files attached, pulled inline');
  lines.push('');
  if (failedPdfs?.length) {
    lines.push(`Note: ${failedPdfs.length} workflow PDF(s) could not be rendered. The`);
    lines.push('JSON snapshot and CSVs still carry the full data — use those for audit if needed.');
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
 */
export async function streamApprovalsZip(approvals, res, { orgId, filters, orgLogoUrl = '' }) {
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

  // Top-level summary CSV first — fast, no I/O.
  archive.append(buildAllWorkflowsCsv(approvals), { name: 'all-workflows.csv' });

  // ── Shared Puppeteer browser for ALL per-workflow PDFs ────────────
  // Launching Chromium is the slow part (~1-2s). The previous code
  // launched it once per workflow, which made a 20-workflow export
  // take 30-60s. Now we launch once up front and reuse the browser
  // for every PDF — each PDF after the first is just a few hundred ms.
  let sharedBrowser = null;
  try {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  } catch (err) {
    // If Chromium can't launch at all the PDFs will all fail; we
    // still ship the JSON/CSV/attachments so the export isn't lost.
    logError('[zip] could not launch Chromium for batched PDFs:', err?.message || err);
  }

  try {
    // One folder per workflow.
    for (const a of approvals) {
      const folder = workflowFolderPath(a);

      // ── Per-workflow PDF — the human-readable audit document ──
      // Reuses sharedBrowser so we skip the per-PDF Chromium warm-up.
      try {
        const pdfResult = await generateApprovalPDF(
          a, null, null, orgLogoUrl, null,
          sharedBrowser ? { browser: sharedBrowser } : undefined
        );
        // Puppeteer v24+ returns a Uint8Array from page.pdf(), but
        // archiver.append() refuses anything that isn't a Buffer,
        // Stream or string. Buffer.from(uint8array) is a zero-copy
        // re-wrap (shares the same underlying memory), so this is
        // cheap even for large PDFs.
        const pdfBuffer = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);
        archive.append(pdfBuffer, { name: `${folder}/workflow.pdf` });
      } catch (err) {
        logError(`[zip] PDF generation failed for ${a._id}:`, err?.message || err);
        failedPdfs.push({ workflow: a._id?.toString(), error: err?.message || String(err) });
      }

      // Supporting CSVs — easy to grep through.
      archive.append(buildTimelineCsv(a),          { name: `${folder}/timeline.csv` });
      archive.append(buildCommentsCsv(a),          { name: `${folder}/comments.csv` });

      // Raw JSON snapshot kept as a structured-data backup for
      // downstream tooling. Auditors don't read it; engineers do.
      archive.append(JSON.stringify(a, null, 2), { name: `${folder}/workflow.json` });

      // Attachments — fetched serially to keep S3 load predictable.
      // We collect each stream into a Buffer BEFORE appending it to
      // the archive. Appending an in-flight Readable means any S3
      // error mid-stream propagates into archiver as a fatal error
      // (which destroys the response, producing the
      // ERR_INCOMPLETE_CHUNKED_ENCODING the client was seeing). With
      // a buffered append, any failure is caught right here and the
      // export keeps going.
      const attachments = collectAttachments(a);
      for (const att of attachments) {
        try {
          const s3 = await getFileStream(att.key);
          const bytes = await new Promise((resolve, reject) => {
            const chunks = [];
            s3.Body.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            s3.Body.on('end',   () => resolve(Buffer.concat(chunks)));
            s3.Body.on('error', reject);
          });
          const filename = `${att.source}__${safeSegment(att.name, 'attachment')}`;
          archive.append(bytes, { name: `${folder}/attachments/${filename}` });
        } catch (err) {
          logError(`[zip] could not fetch attachment ${att.key}:`, err?.message || err);
          missingAttachments.push({ workflow: a._id?.toString(), key: att.key, name: att.name });
        }
      }
    }
  } finally {
    // Always close the shared browser, even if the loop threw.
    if (sharedBrowser) {
      await sharedBrowser.close().catch(() => {});
    }
  }

  // README last so missingAttachments / failedPdfs are accurate.
  archive.append(buildReadme({
    generatedAt: new Date(),
    orgId,
    filters,
    count: approvals.length,
    missingAttachments,
    failedPdfs
  }), { name: 'README.txt' });

  await archive.finalize();
  logInfo(`[zip] approvals export streamed: ${approvals.length} workflows, ${missingAttachments.length} missing attachments, ${failedPdfs.length} PDF failures`);
}

export default { streamApprovalsZip };
