/**
 * bulkImportService — generic, config-driven bulk import engine.
 *
 * Generalises the per-row create+side-effects loop first written for the
 * volunteer import (`bulkVolunteerImportService`) and adds the two things
 * every other entity import needs:
 *
 *   1. DEDUPLICATION — skip rows that duplicate an earlier row in the same
 *      file (in-batch) OR that match a record already in the database.
 *   2. APPROVAL ON IMPORT — optionally raise an approval workflow for each
 *      created record (e.g. suppliers go to `supplier_vetting`). A missing
 *      workflow config never fails the import; the record is still created
 *      and the row is flagged so the UI can surface it.
 *
 * Each entity supplies an `importer` config:
 *
 *   {
 *     entityName:   'supplier',                 // for logs
 *     labelOf(x):   data|raw -> string,         // human label for results
 *     validateRow(raw): { ok, data, errors },   // field map + required checks
 *     dedupe: {                                 // optional
 *       keyOf(data):     string|null,           // in-batch signature
 *       findExisting(ctx, data): doc|null        // DB lookup (async)
 *     },
 *     createOne(ctx, data): doc,                // async; returns created doc
 *     approval: {                               // optional
 *       category: 'supplier_vetting',
 *       raise(ctx, doc): { state } | void        // async; may throw typed errs
 *     },
 *     prepare(ctx):   extraCtx,                  // optional; run once per batch
 *     afterAll(ctx, result): void                // optional; run once at end
 *   }
 *
 * Rows are processed sequentially — the email service and a small tenant
 * Mongoose pool don't love simultaneous bursts, and per-row error reporting
 * is clearer this way. One bad row never rolls back its siblings.
 *
 * Result shape (superset of the volunteer import's, so existing UIs keep
 * working and new UIs can render duplicates):
 *   {
 *     created:    [{ row_number, id, label, approval }],
 *     failed:     [{ row_number, label, errors: [{ field, message }] }],
 *     duplicates: [{ row_number, label, reason, existing_id }],
 *     summary:    { total, created, failed, duplicates },
 *     approval:   { category, configured } | null
 *   }
 *
 * `approval` per created row is one of:
 *   'submitted'      — workflow raised, record routed for approval
 *   'not_configured' — no workflow set up for the category (record created)
 *   'error'          — unexpected failure raising the workflow (record created)
 *   'skipped'        — importer has no approval config
 */

import { logInfo, logError } from '../utils/logger.js';

const safeLabel = (importer, value) => {
  try {
    const label = importer.labelOf ? importer.labelOf(value) : null;
    return label ? String(label) : null;
  } catch {
    return null;
  }
};

/**
 * @param {object} args
 * @param {import('mongoose').Connection} args.tenantDb
 * @param {string} args.orgId     lowercase tenant slug (req.orgId)
 * @param {object} args.actor     { userId, firstName, lastName }
 * @param {Array<object>} args.rows
 * @param {object} args.importer  see module docs
 */
export const runBulkImport = async ({ tenantDb, orgId, actor, rows, importer }) => {
  if (!importer || typeof importer.validateRow !== 'function' || typeof importer.createOne !== 'function') {
    throw new Error('runBulkImport: importer must define validateRow() and createOne()');
  }
  const list = Array.isArray(rows) ? rows : [];

  // Per-batch context shared with every importer hook.
  const ctx = { tenantDb, orgId, actor };
  if (typeof importer.prepare === 'function') {
    Object.assign(ctx, (await importer.prepare(ctx)) || {});
  }

  const created = [];
  const failed = [];
  const duplicates = [];
  const seenKeys = new Set();

  // Tri-state: null = unknown, true = a workflow was found, false = none
  // configured. Once we learn there's no workflow we stop trying to raise
  // one for every subsequent row (avoids N redundant matrix lookups).
  let approvalConfigured = null;

  for (let i = 0; i < list.length; i += 1) {
    const rowNumber = i + 2; // header row = 1; first data row = 2
    const raw = list[i] || {};

    // 1) Validate / map.
    const { ok, data, errors } = importer.validateRow(raw);
    const label = safeLabel(importer, ok ? data : raw);
    if (!ok) {
      failed.push({ row_number: rowNumber, label, errors: errors || [{ field: '_row', message: 'Invalid row' }] });
      continue;
    }

    // 2) Deduplicate.
    const dedupe = importer.dedupe;
    const key = dedupe?.keyOf ? dedupe.keyOf(data) : null;
    if (key && seenKeys.has(key)) {
      duplicates.push({ row_number: rowNumber, label, reason: 'Duplicate of an earlier row in this file', existing_id: null });
      continue;
    }
    if (dedupe?.findExisting) {
      let existing = null;
      try {
        existing = await dedupe.findExisting(ctx, data);
      } catch (err) {
        // A dedup-lookup failure shouldn't block the import — log and treat
        // the row as new. Worst case we create a near-duplicate, which is
        // recoverable; silently dropping a real row is worse.
        logError('Bulk import: dedup lookup failed', err, { entity: importer.entityName, rowNumber, orgId });
      }
      if (existing) {
        if (key) seenKeys.add(key);
        duplicates.push({
          row_number: rowNumber,
          label,
          reason: 'Matches an existing record',
          existing_id: existing?._id ? String(existing._id) : null
        });
        continue;
      }
    }
    if (key) seenKeys.add(key);

    // 3) Create.
    let doc;
    try {
      doc = await importer.createOne(ctx, data);
    } catch (err) {
      logError('Bulk import: row create failed', err, { entity: importer.entityName, rowNumber, orgId });
      failed.push({
        row_number: rowNumber,
        label,
        errors: [{ field: '_row', message: err?.message || 'Failed to create record' }]
      });
      continue;
    }

    // 4) Approval on import (optional).
    let approvalState = 'skipped';
    if (importer.approval?.raise) {
      if (approvalConfigured === false) {
        // We already discovered there's no workflow for this category — don't
        // re-check on every row.
        approvalState = 'not_configured';
      } else {
        try {
          const res = await importer.approval.raise(ctx, doc);
          approvalState = res?.state || 'submitted';
          approvalConfigured = true;
        } catch (err) {
          if (err?.code === 'WORKFLOW_NOT_CONFIGURED' || err?.code === 'NO_APPROVERS') {
            approvalState = 'not_configured';
            approvalConfigured = false;
          } else {
            approvalState = 'error';
            logError('Bulk import: raise approval failed', err, { entity: importer.entityName, rowNumber, orgId });
          }
        }
      }
    }

    created.push({ row_number: rowNumber, id: String(doc._id), label, approval: approvalState });
  }

  if (typeof importer.afterAll === 'function') {
    try {
      await importer.afterAll(ctx, { created, failed, duplicates });
    } catch (err) {
      logError('Bulk import: afterAll hook failed', err, { entity: importer.entityName, orgId });
    }
  }

  logInfo('Bulk import complete', {
    entity: importer.entityName,
    orgId,
    total: list.length,
    created: created.length,
    failed: failed.length,
    duplicates: duplicates.length
  });

  return {
    created,
    failed,
    duplicates,
    summary: {
      total: list.length,
      created: created.length,
      failed: failed.length,
      duplicates: duplicates.length
    },
    approval: importer.approval
      ? { category: importer.approval.category || null, configured: approvalConfigured }
      : null
  };
};

export default { runBulkImport };
