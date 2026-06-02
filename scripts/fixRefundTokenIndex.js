/**
 * One-time migration — fix the project_refunds token index.
 *
 * Before manual refunds existed, the schema defined a plain unique
 * index on { org_key, token }. Manual entries have no token, so a
 * second manual save collides on `dup key: { ..., token: null }`.
 *
 * This script lists every index on `project_refunds`, drops any plain
 * unique index that includes `token` (regardless of index name), and
 * creates the partial unique index the schema now defines. Safe to
 * re-run; idempotent.
 *
 * Usage:
 *   node scripts/fixRefundTokenIndex.js                # all tenants
 *   node scripts/fixRefundTokenIndex.js organization_5  # one tenant
 *   node scripts/fixRefundTokenIndex.js --dry-run …    # diagnostic only
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { connectRouterDB } from '../src/config/database.js';
import { getTenantConnection } from '../src/db/connectionManager.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TARGET = args.find((a) => !a.startsWith('--'));

// Keys we want to keep covered by the partial unique pattern:
const PARTIAL_PAIRS = [
  // [keyName, mongoType for partial filter]
  { field: 'token',              type: 'string' },
  { field: 'payment_ack_token',  type: 'string' }
];

function indexCoversField(idx, field) {
  return idx?.key && Object.prototype.hasOwnProperty.call(idx.key, field);
}

async function fixOne(orgId) {
  const tenantDb = await getTenantConnection(orgId);
  const collection = tenantDb.collection('project_refunds');

  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (err) {
    if (err?.code === 26) {
      console.log(`  ${orgId}: collection does not exist yet — nothing to do`);
      return;
    }
    throw err;
  }

  console.log(`  ${orgId}: ${indexes.length} indexes on project_refunds:`);
  for (const i of indexes) {
    const flag = [
      i.unique ? 'unique' : null,
      i.partialFilterExpression ? 'partial' : null
    ].filter(Boolean).join(',') || 'plain';
    console.log(`    - ${i.name}  ${JSON.stringify(i.key)}  [${flag}]`);
  }

  for (const pair of PARTIAL_PAIRS) {
    // Drop ANY index that:
    //   - covers org_key + the partial field (or just the partial field)
    //   - is unique
    //   - is NOT partial (would collide on nulls)
    // Don't touch _id_; don't touch indexes that already have a partial filter.
    const bad = indexes.filter((i) =>
      i.name !== '_id_'
      && i.unique === true
      && !i.partialFilterExpression
      && indexCoversField(i, pair.field)
    );

    for (const idx of bad) {
      if (DRY_RUN) {
        console.log(`    [dry-run] would drop ${idx.name}`);
        continue;
      }
      console.log(`    dropping non-partial unique index '${idx.name}'`);
      try {
        await collection.dropIndex(idx.name);
      } catch (err) {
        console.warn(`      could not drop ${idx.name}:`, err?.message || err);
      }
    }

    // Ensure the partial version exists.
    const targetSpec = { org_key: 1, [pair.field]: 1 };
    const targetExists = indexes.some((i) =>
      i.unique === true
      && i.partialFilterExpression
      && JSON.stringify(i.key) === JSON.stringify(targetSpec)
    );
    if (targetExists) {
      console.log(`    partial unique on { org_key, ${pair.field} } already present`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`    [dry-run] would create partial unique on { org_key, ${pair.field} }`);
      continue;
    }
    console.log(`    creating partial unique on { org_key, ${pair.field} }`);
    await collection.createIndex(targetSpec, {
      unique: true,
      partialFilterExpression: { [pair.field]: { $type: pair.type } }
    });
  }
}

async function run() {
  await connectRouterDB();
  const routerConn = mongoose.connection;

  let tenants = [];
  if (TARGET) {
    tenants = [{ org_id: TARGET }];
    console.log(`Targeting single tenant: ${TARGET}`);
  } else {
    tenants = await routerConn.collection('tenants').find({}).project({ org_id: 1 }).toArray();
    console.log(`Found ${tenants.length} tenants`);
  }

  for (const t of tenants) {
    const orgId = t.org_id;
    if (!orgId) continue;
    console.log(`Tenant: ${orgId}`);
    try {
      await fixOne(orgId);
    } catch (err) {
      console.error(`  ${orgId}: FAILED —`, err?.message || err);
    }
  }

  console.log(DRY_RUN ? 'Dry-run complete.' : 'Done.');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration crashed:', err);
  process.exit(1);
});
