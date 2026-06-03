/**
 * Policy Marketplace seed service.
 *
 * Walks the on-disk `_Policy Templates (DOCX)` folder bundled with the
 * backend repo and pushes every DOCX into the Marketplace as a Policy,
 * grouped by Module (one MarketplacePolicyGroup per Module). Reusable
 * by both `scripts/seedPolicyMarketplace.js` (CLI) and the
 * `POST /admin/policy-templates/seed-defaults` admin endpoint (UI).
 *
 * Idempotent. Re-runnable. Existing groups are matched by slug,
 * existing policies by (group_id + title, case-insensitive).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import getRouterModels from '../db/models/routerModels.js';
import { uploadToS3 } from './s3Service.js';
import { convertDocxBufferToPdfBuffer } from './docxToPdfService.js';
import { logError } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Catalogue (from 00 - Policy Template Catalogue.docx) ──────────────
// Each entry is "one Marketplace group". `folder` is the on-disk
// directory name we walk; `slug` is the canonical id we match on so
// reseeding hits the same group instead of duplicating it. `name` is
// what the customer sees in the marketplace — kept as a clean heading
// (no "Module N —" prefix) at the request of the operator.
export const MODULES = [
  { folder: 'Module 0', name: 'Charity Foundations & Administration', slug: 'module-0-charity-foundations-administration', description: 'Core charity records: governing documents, licences, tax exemptions, privacy.', sort_order: 0 },
  { folder: 'Module 1', name: 'Document & Policy Control',            slug: 'module-1-document-policy-control',            description: 'Master register and version control for every policy in your organisation.', sort_order: 10 },
  { folder: 'Module 2', name: 'People & Governance',                   slug: 'module-2-people-governance',                   description: 'Board, directors, employees, volunteers and consultants — inductions, COI, and duties.', sort_order: 20 },
  { folder: 'Module 3', name: 'Operations & Programs',                 slug: 'module-3-operations-programs',                 description: 'Field operations, partner due diligence, project delivery, safeguarding and complaints.', sort_order: 30 },
  { folder: 'Module 4', name: 'Finance',                               slug: 'module-4-finance',                             description: 'Cash handling, approvals, BAS, refunds, month-end and AML/CTF controls.', sort_order: 40 },
  { folder: 'Module 5', name: 'Marketing',                             slug: 'module-5-marketing',                           description: 'Marketing compliance, training, performance, social media access and reporting.', sort_order: 50 },
  { folder: 'Module 6', name: 'Relationships & Donor Care',            slug: 'module-6-relationships-donor-care',            description: 'Donor stewardship, donation boxes, community sponsorships and VIP donor care.', sort_order: 60 },
  { folder: 'Module 7', name: 'Compliance, Audits & Reporting',        slug: 'module-7-compliance-audits-reporting',         description: 'AIS submission, internal & external audits, annual reports and whistleblowing.', sort_order: 70 },
  { folder: 'Module 8', name: 'Risk, Continuity & Security',           slug: 'module-8-risk-continuity-security',            description: 'Risk management, business continuity, emergency financials and access controls.', sort_order: 80 },
  { folder: 'Add Ons',  name: 'Cross-Cutting Policies',                slug: 'add-ons-cross-cutting',                        description: 'Child protection, constitution templates and other safeguarding cross-cutting policies.', sort_order: 90 }
];

// Templates ship in the backend repo under
// `_Policy Templates (DOCX)/_Policy Templates (DOCX)/`. From this file
// at `src/services/`, that's "up two, then into the templates folder".
const TEMPLATES_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '_Policy Templates (DOCX)',
  '_Policy Templates (DOCX)'
);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Strip the ".docx" extension; everything else is the human-readable title. */
function titleFromFilename(filename) {
  return filename.replace(/\.docx$/i, '').trim();
}

/** Escape a string for safe use inside a $regex literal match. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run the seeder.
 *
 * @param {object} opts
 * @param {boolean} [opts.published=false]   — create policies as 'published' (default 'draft').
 * @param {number}  [opts.priceCents=0]      — default price per policy in cents.
 * @param {string[]} [opts.onlyModules]      — folder names to scope to (e.g. ['Module 0']).
 * @param {string|null} [opts.createdById]   — user id stamped on created docs.
 * @param {(line: string) => void} [opts.log] — optional log sink (CLI prints; admin route ignores).
 * @returns {Promise<{groupsCreated:number, groupsExisting:number, policiesCreated:number, policiesExisting:number, errors:string[], modules:Array}>}
 */
export async function seedPolicyMarketplace(opts = {}) {
  const {
    published = false,
    priceCents = 0,
    onlyModules = null,
    createdById = null,
    log = () => {}
  } = opts;

  const summary = {
    groupsCreated: 0,
    groupsExisting: 0,
    policiesCreated: 0,
    policiesExisting: 0,
    errors: [],
    // Per-module breakdown so the UI can render a tidy table after the run.
    modules: []
  };

  // Confirm the templates folder is actually on disk before we touch S3
  // or Mongo. If a deploy ever drops it, fail fast with a useful message.
  try {
    await fs.access(TEMPLATES_ROOT);
  } catch {
    summary.errors.push(`Templates folder missing on disk at ${TEMPLATES_ROOT}`);
    return summary;
  }

  const { MarketplacePolicyGroup, MarketplacePolicy } = getRouterModels();
  const scope = onlyModules ? new Set(onlyModules) : null;

  for (const mod of MODULES) {
    if (scope && !scope.has(mod.folder)) continue;

    const moduleSummary = {
      folder: mod.folder,
      name: mod.name,
      slug: mod.slug,
      policies_uploaded: 0,
      policies_existing: 0,
      group_created: false,
      group_existing: false,
      errors: []
    };

    const modulePath = path.join(TEMPLATES_ROOT, mod.folder);
    let dirents;
    try {
      dirents = await fs.readdir(modulePath, { withFileTypes: true });
    } catch {
      const msg = `Folder missing on disk: ${mod.folder}`;
      moduleSummary.errors.push(msg);
      summary.errors.push(msg);
      summary.modules.push(moduleSummary);
      log(`!  Skipping ${mod.folder} — folder missing on disk`);
      continue;
    }

    // `~$…docx` are Word lock files for currently-open docs; ignore them.
    const docxFiles = dirents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.docx') && !d.name.startsWith('~$'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));

    log(`\n▾ ${mod.name}`);
    log(`  folder: ${mod.folder}  (${docxFiles.length} docx files)`);

    // ── Upsert the group ──────────────────────────────────────────
    let groupId;
    const existingGroup = await MarketplacePolicyGroup.findOne({ slug: mod.slug }).lean();
    if (existingGroup) {
      groupId = existingGroup._id;
      summary.groupsExisting += 1;
      moduleSummary.group_existing = true;
      log(`  group exists — id=${groupId}`);
    } else {
      const created = await MarketplacePolicyGroup.create({
        name: mod.name,
        slug: mod.slug,
        description: mod.description,
        sort_order: mod.sort_order,
        status: 'active',
        created_by: createdById
      });
      groupId = created._id;
      summary.groupsCreated += 1;
      moduleSummary.group_created = true;
      log(`  group created — id=${groupId}`);
    }

    // ── Upsert each policy ────────────────────────────────────────
    for (const filename of docxFiles) {
      const title = titleFromFilename(filename);
      const filepath = path.join(modulePath, filename);

      // Idempotency check — same group_id + same title (case-insensitive)
      // means this DOCX has already been ingested. Skip the S3 upload
      // entirely so re-runs are cheap.
      const existing = await MarketplacePolicy.findOne({
        group_id: groupId,
        title: { $regex: `^${escapeRegex(title)}$`, $options: 'i' }
      }).lean();
      if (existing) {
        summary.policiesExisting += 1;
        moduleSummary.policies_existing += 1;
        log(`    skip  ${title}  (exists)`);
        continue;
      }

      let buffer;
      try {
        buffer = await fs.readFile(filepath);
      } catch (err) {
        const msg = `Read failed: ${filename} — ${err.message}`;
        summary.errors.push(msg);
        moduleSummary.errors.push(msg);
        log(`    READ ERR  ${title}: ${err.message}`);
        continue;
      }

      // Upload the source DOCX via the same S3 helper the admin upload
      // route uses, so these files land in the same
      // `_marketplace/policy-template/…` prefix as anything the
      // human-driven admin UI uploads.
      let upload;
      try {
        upload = await uploadToS3(
          buffer,
          filename,
          DOCX_MIME,
          '_marketplace',
          'policy-template'
        );
      } catch (err) {
        const msg = `S3 upload failed: ${filename} — ${err.message}`;
        summary.errors.push(msg);
        moduleSummary.errors.push(msg);
        log(`    UPLOAD ERR  ${title}: ${err.message}`);
        continue;
      }

      // Pre-generate the PDF preview now so the marketplace card has a
      // thumbnail immediately and the lazy convert-on-first-request path
      // doesn't have to fire. Conversion failures are non-fatal — the
      // policy is still created and the existing lazy path will retry on
      // first preview request, so worst case the operator sees "Preview
      // Unavailable" until a viewer triggers the fallback conversion.
      let previewKey = '';
      try {
        const pdfBuf = await convertDocxBufferToPdfBuffer(buffer);
        const previewName = filename.replace(/\.docx$/i, '') + '-preview.pdf';
        const previewUpload = await uploadToS3(
          pdfBuf,
          previewName,
          'application/pdf',
          '_marketplace',
          'policy-template-preview'
        );
        previewKey = previewUpload.key;
        log(`    preview  ${title}  (${(pdfBuf.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        // Don't push to `summary.errors` — a failed preview is a
        // degraded outcome, not a failure of the seed itself. Note it
        // in the log so the operator can spot a pattern (e.g. puppeteer
        // missing, in which case every file would fail and the lazy
        // path on the public route would too).
        logError('[seed preview convert failed]', { title, err: err?.message || String(err) });
        log(`    preview ERR  ${title}: ${err?.message || err}`);
      }

      try {
        await MarketplacePolicy.create({
          group_id: groupId,
          title,
          description: '',
          summary: '',
          price_aud_cents: priceCents,
          file: {
            s3_key: upload.key,
            original_name: filename,
            mime_type: DOCX_MIME,
            format: 'docx',
            bytes: upload.bytes,
            // Empty string is fine — the public preview-stream route
            // detects the empty key and runs the lazy conversion +
            // cache path. Pre-populating just skips that round-trip.
            pdf_preview_key: previewKey
          },
          tags: [],
          version: 1,
          status: published ? 'published' : 'draft',
          created_by: createdById
        });
        summary.policiesCreated += 1;
        moduleSummary.policies_uploaded += 1;
        log(`    add   ${title}`);
      } catch (err) {
        const msg = `Mongo insert failed: ${title} — ${err.message}`;
        summary.errors.push(msg);
        moduleSummary.errors.push(msg);
        log(`    INSERT ERR  ${title}: ${err.message}`);
      }
    }

    summary.modules.push(moduleSummary);
  }

  return summary;
}

/**
 * Sweep every DOCX marketplace policy and back-fill any missing PDF
 * preview. Used to rescue an old seed that was run before this service
 * generated previews at upload time. Uses the SAME conversion pipeline
 * as the lazy path so the cached output is identical.
 *
 * Returns { scanned, generated, skipped, failed: [{title, error}] }.
 */
export async function backfillMarketplacePreviews({ limit = 200, log = () => {} } = {}) {
  const { MarketplacePolicy } = getRouterModels();
  const { getFileStream } = await import('./s3Service.js');

  const policies = await MarketplacePolicy.find({
    'file.format': 'docx',
    $or: [
      { 'file.pdf_preview_key': '' },
      { 'file.pdf_preview_key': { $exists: false } }
    ]
  }).limit(limit);

  const result = { scanned: policies.length, generated: 0, skipped: 0, failed: [] };

  for (const policy of policies) {
    const srcKey = policy.file?.s3_key;
    const title = policy.title || '(untitled)';
    if (!srcKey) {
      result.skipped += 1;
      log(`  skip   ${title}  (no source file)`);
      continue;
    }
    try {
      const stream = await getFileStream(srcKey);
      const docxBuf = await new Promise((resolve, reject) => {
        const chunks = [];
        stream.Body.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.Body.on('end', () => resolve(Buffer.concat(chunks)));
        stream.Body.on('error', reject);
      });
      const pdfBuf = await convertDocxBufferToPdfBuffer(docxBuf);
      const previewName = (policy.file?.original_name || title).replace(/\.[^.]+$/, '') + '-preview.pdf';
      const previewUpload = await uploadToS3(
        pdfBuf,
        previewName,
        'application/pdf',
        '_marketplace',
        'policy-template-preview'
      );
      policy.file.pdf_preview_key = previewUpload.key;
      await policy.save();
      result.generated += 1;
      log(`  done   ${title}  (${(pdfBuf.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      result.failed.push({ title, error: err?.message || String(err) });
      logError('[preview backfill failed]', { title, err: err?.message || String(err) });
      log(`  ERR    ${title}: ${err?.message || err}`);
    }
  }
  return result;
}

/** Map the catalogue's user-facing module folder names back to validation IDs. */
export function moduleFolderFromArg(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'addons' || s === 'add-ons' || s === 'add ons') return 'Add Ons';
  if (/^\d+$/.test(s)) return `Module ${Number(s)}`;
  return null;
}

export default seedPolicyMarketplace;
