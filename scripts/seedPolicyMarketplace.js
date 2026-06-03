/**
 * CLI wrapper around the policy-marketplace seed service.
 *
 * Walks `_Policy Templates (DOCX)/`, uploads each DOCX to S3, and
 * creates MarketplacePolicy / MarketplacePolicyGroup rows in the
 * Router DB. All the actual work lives in
 * `src/services/policyMarketplaceSeedService.js` so the admin
 * "Load default policies" endpoint can share the same code path.
 *
 *   node scripts/seedPolicyMarketplace.js [--dry] [--published] [--price=N] [--module=N|addons]
 */

import dotenv from 'dotenv';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import {
  seedPolicyMarketplace,
  moduleFolderFromArg,
  MODULES
} from '../src/services/policyMarketplaceSeedService.js';

dotenv.config();

function parseArgs(argv) {
  const cfg = { dry: false, published: false, priceCents: 0, onlyModules: null };
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
      const folder = moduleFolderFromArg(a.slice('--module='.length));
      if (!folder) {
        console.error(`Invalid --module value: ${a} (expected 0–8 or "addons")`);
        process.exit(1);
      }
      only.push(folder);
    }
  }
  if (only.length) cfg.onlyModules = only;
  return cfg;
}

async function main() {
  const cfg = parseArgs(process.argv);
  console.log('Seeding Policy Marketplace');
  if (cfg.dry) console.log('  [dry run — no Mongo writes, no S3 uploads]');
  if (cfg.published) console.log('  [creating policies as PUBLISHED]');
  if (cfg.onlyModules) console.log('  [scoped to:', cfg.onlyModules.join(', '), ']');
  console.log('  [default price: AUD', (cfg.priceCents / 100).toFixed(2), ']');
  console.log('');

  if (cfg.dry) {
    // For dry runs we just enumerate what the live run would do, without
    // touching Mongo or S3 — useful for confirming folder paths before
    // pulling the trigger.
    for (const mod of MODULES) {
      if (cfg.onlyModules && !cfg.onlyModules.includes(mod.folder)) continue;
      console.log(`▾ ${mod.name}  (folder: ${mod.folder})`);
    }
    console.log('\nDone.');
    process.exit(0);
  }

  console.log('Connecting to Router DB…');
  await connectRouterDB();
  console.log('Connected.');

  const summary = await seedPolicyMarketplace({
    published: cfg.published,
    priceCents: cfg.priceCents,
    onlyModules: cfg.onlyModules,
    log: (line) => console.log(line)
  });

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

  console.log('\nClosing Router DB connection…');
  await closeRouterDB();
  console.log('Done.');
  process.exit(summary.errors.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  try { await closeRouterDB(); } catch { /* already closed */ }
  process.exit(1);
});
