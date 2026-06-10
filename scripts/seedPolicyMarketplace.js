 broth/**
 * Bulk-seed the Policy Marketplace from the on-disk DOCX folder.
 *
 *   /_Policy Templates (DOCX)/_Policy Templates (DOCX)/
 *     Module 0/  *.docx
 *     Module 1/  *.docx
 *     …
 *     Add Ons/   *.docx
 *
 * For each module folder we (a) upsert a MarketplacePolicyGroup with the
 * official catalogue name, (b) upload every DOCX inside to S3 via the
 * same `uploadToS3` helper the admin route uses, and (c) insert a
 * MarketplacePolicy row pointing at the upload.
 *
 * Idempotent — re-runnable. Existing groups are matched by slug, and
 * existing policies by (group_id + title); if a row is already there we
 * skip the S3 upload entirely so the script is cheap to re-run after a
 * partial failure.
 *
 * Run:
 *   cd charitycompliance-backend
 *   node scripts/seedPolicyMarketplace.js
 *
 * Flags:
 *   --dry        Don't write to Mongo or upload to S3. Prints the plan.
 *   --published  Create policies as `published` (default: `draft`).
 *   --price=199  Default price in AUD dollars for every policy (default 0).
 *   --module=N   Only seed Module N (0–8) or "addons". Repeatable.
 */

import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import getRouterModels from '../src/db/models/routerModels.js';
import { uploadToS3 } from '../src/services/s3Service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Catalogue: official module → group config ──────────────────────────
// Names + descriptions come straight from the 00-Catalogue.docx. Slugs
// are stable so a re-run hits the same group instead of duplicating it.
const MODULES = [
  {
    folder: 'Module 0',
    name: 'Module 0 — Charity Foundations & Administration',
    slug: 'module-0-charity-foundations-administration',
    description: 'Core charity records: governing documents, licences, tax exemptions, privacy.',
    sort_order: 0
  },
  {
    folder: 'Module 1',
    name: 'Module 1 — Document & Policy Control',
    slug: 'module-1-document-policy-control',
    description: 'Master register and version control for every policy in your organisation.',
    sort_order: 10
  },
  {
    folder: 'Module 2',
    name: 'Module 2 — People & Governance',
    slug: 'module-2-people-governance',
    description: 'Board, directors, employees, volunteers and consultants — inductions, COI, and duties.',
    sort_order: 20
  },
  {
    folder: 'Module 3',
    name: 'Module 3 — Operations & Programs',
    slug: 'module-3-operations-programs',
    description: 'Field operations, partner due diligence, project delivery, safeguarding and complaints.',
    sort_order: 30
  },
  {
    folder: 'Module 4',
    name: 'Module 4 — Finance',
    slug: 'module-4-finance',
    description: 'Cash handling, approvals, BAS, refunds, month-end and AML/CTF controls.',
    sort_order: 40
  },
  {
    folder: 'Module 5',
    name: 'Module 5 — Marketing',
    slug: 'module-5-marketing',
    description: 'Marketing compliance, training, performance, social media access and reporting.',
    sort_order: 50
  },
  {
    folder: 'Module 6',
    name: 'Module 6 — Relationships & Donor Care',
    slug: 'module-6-relationships-donor-care',
    description: 'Donor stewardship, donation boxes, community sponsorships and VIP donor care.',
    sort_order: 60
  },
  {
    folder: 'Module 7',
    name: 'Module 7 — Compliance, Audits & Reporting',
    slug: 'module-7-compliance-audits-reporting',
    description: 'AIS submission, internal & external audits, annual reports and whistleblowing.',
    sort_order: 70
  },
  {
    folder: 'Module 8',
    name: 'Module 8 — Risk, Continuity & Security',
    slug: 'module-8-risk-continuity-security',
    description: 'Risk management, business continuity, emergency financials and access controls.',
    sort_order: 80
  },
  {
    folder: 'Add Ons',
    name: 'Add-Ons — Cross-Cutting Policies',
    slug: 'add-ons-cross-cutting',
    description: 'Child protection, constitution templates and other safeguarding cross-cutting policies.',
    sort_order: 90
  }
];

// Root containing the module folders. Note the doubled-up directory
// structure on disk: `_Policy Templates (DOCX)/_Policy Templates (DOCX)/Module 0`.
const TEMPLATES_ROOT = path.resolve(
  __dirname,
  '..',
  '_Policy Templates (DOCX)',
  '_Policy Templates (DOCX)'
);

// MIME type for .docx files — matches what the admin upload route checks.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Strip the trailing " Policy" / " Procedure" suffix? We KEEP it — the
// catalogue treats the suffix as part of the canonical title and the UI
// is happy displaying long titles.
function titleFromFilename(filename) {
  return filename.replace(/\.docx$/i, '').trim();
}

// Parse CLI flags up-front so the rest of the script can read a config.
function parseArgs(argv) {
  const cfg = {
    dry: false,
    published: false,
    priceCents: 0,
    onlyModules: null // null = all, otherwise Set of folder names
  };
  const only = [];
  for (const a of argv.slice(2)) {
    if (a === '--dry') cfg.dry = true;
    else if (a === '--published') cfg.published = true;
    else if (a.startsWith('--price=')) {
      const dollars = Number(a.slice('--price='.length));
      if (!Number.isFinite(dollars) || dollars < 0) {
        console.error(`Invalid --price value: ${a}`);
        process.exit(1);
      }
      cfg.priceCents = Math.round(dollars * 100);
    } else if (a.startsWith('--module=')) {
      const v = a.slice('--module='.length).trim();
      if (v.toLowerCase() === 'addons' || v.toLowerCase() === 'add-ons') only.push('Add Ons');
      else if (/^\d+$/.test(v)) only.push(`Module ${Number(v)}`);
      else {
        console.error(`Invalid --module value: ${a} (expected 0–8 or "addons")`);
        process.exit(1);
      }
    }
  }
  if (only.length) cfg.onlyModules = new Set(only);
  return cfg;
}

// Pretty-print a count summary so a one-line tail of the log reads as a
// receipt for what changed.
function printSummary(summary) {
  console.log('');
  console.log('─'.repeat(60));
  console.log('  Marketplace seed summary');
  console.log('─'.repeat(60));
  console.log(`  Groups created: ${summary.groupsCreated}`);
  console.log(`  Groups already present: ${summary.groupsExisting}`);
  console.log(`  Policies uploaded: ${summary.policiesCreated}`);
  console.log(`  Policies skipped (already present): ${summary.policiesExisting}`);
  console.log(`  Errors: ${summary.errors.length}`);
  console.log('─'.repeat(60));
  if (summary.errors.length) {
    console.log('  Errors:');
    for (const e of summary.errors) console.log(`    • ${e}`);
    console.log('─'.repeat(60));
  }
}

async function main() {
  const cfg = parseArgs(process.argv);
  console.log('Seeding Policy Marketplace from', TEMPLATES_ROOT);
  if (cfg.dry) console.log('  [dry run — no Mongo writes, no S3 uploads]');
  if (cfg.published) console.log('  [creating policies as PUBLISHED]');
  if (cfg.onlyModules) console.log('  [scoped to:', Array.from(cfg.onlyModules).join(', '), ']');
  console.log('  [default price: AUD', (cfg.priceCents / 100).toFixed(2), ']');
  console.log('');

  // Verify the templates folder exists before we touch Mongo.
  try {
    await fs.access(TEMPLATES_ROOT);
  } catch {
    console.error(`Templates root not found: ${TEMPLATES_ROOT}`);
    console.error('Expected the unzipped folder to sit at:');
    console.error('  charitycompliance-backend/_Policy Templates (DOCX)/_Policy Templates (DOCX)/');
    process.exit(1);
  }

  if (!cfg.dry) {
    console.log('Connecting to Router DB…');
    await connectRouterDB();
    console.log('Connected.');
  }

  const summary = {
    groupsCreated: 0,
    groupsExisting: 0,
    policiesCreated: 0,
    policiesExisting: 0,
    errors: []
  };

  // We don't import models at the top — only after the connection is up,
  // so getRouterModels resolves against the live connection.
  const models = cfg.dry ? null : getRouterModels();
  const { MarketplacePolicyGroup, MarketplacePolicy } = models || {};

  for (const mod of MODULES) {
    if (cfg.onlyModules && !cfg.onlyModules.has(mod.folder)) continue;

    const modulePath = path.join(TEMPLATES_ROOT, mod.folder);
    let dirents;
    try {
      dirents = await fs.readdir(modulePath, { withFileTypes: true });
    } catch {
      console.warn(`!  Skipping ${mod.folder} — folder missing on disk`);
      continue;
    }

    const docxFiles = dirents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.docx') && !d.name.startsWith('~$'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));

    console.log(`\n▾ ${mod.name}`);
    console.log(`  folder: ${mod.folder}  (${docxFiles.length} docx files)`);

    // ── Upsert the group ────────────────────────────────────────────
    let groupId;
    if (cfg.dry) {
      console.log(`  [dry] would upsert group slug="${mod.slug}"`);
      groupId = new mongoose.Types.ObjectId();
    } else {
      const existingGroup = await MarketplacePolicyGroup.findOne({ slug: mod.slug }).lean();
      if (existingGroup) {
        groupId = existingGroup._id;
        summary.groupsExisting += 1;
        console.log(`  group exists — id=${groupId}`);
      } else {
        const created = await MarketplacePolicyGroup.create({
          name: mod.name,
          slug: mod.slug,
          description: mod.description,
          sort_order: mod.sort_order,
          status: 'active'
        });
        groupId = created._id;
        summary.groupsCreated += 1;
        console.log(`  group created — id=${groupId}`);
      }
    }

    // ── Upsert each policy ──────────────────────────────────────────
    for (const filename of docxFiles) {
      const title = titleFromFilename(filename);
      const filepath = path.join(modulePath, filename);

      if (cfg.dry) {
        console.log(`    [dry] would upload "${title}"`);
        continue;
      }

      // Idempotency: match by (group_id, title) — case-insensitive.
      const existing = await MarketplacePolicy.findOne({
        group_id: groupId,
        title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
      }).lean();
      if (existing) {
        summary.policiesExisting += 1;
        console.log(`    skip  ${title}  (exists)`);
        continue;
      }

      let buffer;
      try {
        buffer = await fs.readFile(filepath);
      } catch (err) {
        summary.errors.push(`Read failed: ${filepath} — ${err.message}`);
        console.error(`    READ ERR  ${title}: ${err.message}`);
        continue;
      }

      // Upload via the same helper the admin route uses — keeps the S3
      // key layout consistent. `orgId = '_marketplace'` matches the
      // POST /admin/policy-templates/policies path.
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
        summary.errors.push(`S3 upload failed: ${filename} — ${err.message}`);
        console.error(`    UPLOAD ERR  ${title}: ${err.message}`);
        continue;
      }

      try {
        await MarketplacePolicy.create({
          group_id: groupId,
          title,
          description: '',
          summary: '',
          price_aud_cents: cfg.priceCents,
          file: {
            s3_key: upload.key,
            original_name: filename,
            mime_type: DOCX_MIME,
            format: 'docx',
            bytes: upload.bytes,
            pdf_preview_key: '' // generated downstream when previews are wired up
          },
          tags: [],
          version: 1,
          status: cfg.published ? 'published' : 'draft',
          created_by: null
        });
        summary.policiesCreated += 1;
        console.log(`    add   ${title}`);
      } catch (err) {
        summary.errors.push(`Mongo insert failed: ${title} — ${err.message}`);
        console.error(`    INSERT ERR  ${title}: ${err.message}`);
      }
    }
  }

  printSummary(summary);

  if (!cfg.dry) {
    console.log('\nClosing Router DB connection…');
    await closeRouterDB();
  }
  console.log('Done.');
  process.exit(summary.errors.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  try { await closeRouterDB(); } catch { /* already closed */ }
  process.exit(1);
});
