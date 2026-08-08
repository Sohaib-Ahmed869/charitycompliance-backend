/**
 * FULL CLUSTER MIGRATION
 *
 * Copies EVERY database (router DB + every per-tenant org DB) from the cluster
 * in ROUTER_DB_URI to the cluster in NEW_ROUTE_DB_URI:
 *   - collections (with their creation options: capped, validator, collation…)
 *   - all documents, preserving _id and raw BSON (encrypted fields copy as-is,
 *     so MASTER_KEY_HEX keeps working — no re-encryption needed)
 *   - all indexes (unique, partial, TTL, text, compound…)
 *   - views
 *   - router.tenants[].clusterEndpoint rewritten to the NEW cluster, so the
 *     app routes tenants to the new cluster after cutover
 *
 * Usage:
 *   node scripts/migrateCluster.js                  # DRY RUN — plan only, writes nothing
 *   node scripts/migrateCluster.js --execute        # perform the migration
 *   node scripts/migrateCluster.js --execute --drop-target   # wipe target collections first
 *   node scripts/migrateCluster.js --execute --only router,org_testing_v1
 *   node scripts/migrateCluster.js --execute --keep-endpoints  # don't rewrite tenants.clusterEndpoint
 *
 * Re-running is safe: documents are upserted by _id, so a partial run can be
 * resumed by simply running the command again.
 */

import {
  connect,
  getUris,
  listCollections,
  listViews,
  listUserDbs,
  baseUri,
  hostOf,
  mask,
  fmt,
} from './clusterMigrationLib.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const EXECUTE = has('--execute');
const DROP_TARGET = has('--drop-target');
const KEEP_ENDPOINTS = has('--keep-endpoints');
const ONLY = (valueOf('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const BATCH = parseInt(valueOf('--batch') || '500', 10);

const stats = {
  dbs: 0,
  collections: 0,
  docsRead: 0,
  docsWritten: 0,
  indexes: 0,
  views: 0,
  warnings: [],
};

function warn(msg) {
  stats.warnings.push(msg);
  console.log(`    ! ${msg}`);
}

/** Copy one collection: options, documents, indexes. */
async function copyCollection(srcDb, dstDb, info) {
  const name = info.name;
  const srcColl = srcDb.collection(name);
  const total = await srcColl.countDocuments();
  stats.docsRead += total;
  stats.collections += 1;

  const existing = dstDb ? await dstDb.listCollections({ name }).toArray() : [];

  if (!EXECUTE) {
    const idx = await srcColl.indexes();
    stats.indexes += idx.filter((i) => i.name !== '_id_').length;
    console.log(
      `    ${name.padEnd(42)} ${String(fmt(total)).padStart(9)} docs, ${idx.length} idx` +
      (existing.length ? '   [target collection EXISTS]' : '')
    );
    return;
  }

  // 1. Create the collection with the source's options (capped, validator, …)
  if (existing.length && DROP_TARGET) {
    await dstDb.collection(name).drop().catch(() => {});
    existing.length = 0;
  }
  if (!existing.length) {
    const opts = { ...(info.options || {}) };
    delete opts.autoIndexId;
    try {
      await dstDb.createCollection(name, opts);
    } catch (err) {
      if (err.codeName !== 'NamespaceExists') throw err;
    }
  }

  // 2. Copy documents — upsert by _id so re-runs are idempotent/resumable
  const dstColl = dstDb.collection(name);
  let written = 0;
  let buffer = [];
  const flush = async () => {
    if (!buffer.length) return;
    const ops = buffer.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    }));
    const res = await dstColl.bulkWrite(ops, { ordered: false });
    written += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
    buffer = [];
    process.stdout.write(`\r    ${name.padEnd(42)} ${fmt(written)}/${fmt(total)} docs`);
  };

  const cursor = srcColl.find({}, { raw: false }).batchSize(BATCH);
  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= BATCH) await flush();
  }
  await flush();
  stats.docsWritten += written;

  // 3. Recreate indexes (skip _id_, which Mongo creates automatically)
  const srcIndexes = (await srcColl.indexes()).filter((i) => i.name !== '_id_');
  let idxOk = 0;
  for (const idx of srcIndexes) {
    const { key, name: idxName, v, ns, background, ...options } = idx;
    try {
      await dstColl.createIndex(key, { name: idxName, ...options });
      idxOk += 1;
    } catch (err) {
      if (err.codeName === 'IndexOptionsConflict' || err.codeName === 'IndexKeySpecsConflict') {
        await dstColl.dropIndex(idxName).catch(() => {});
        try {
          await dstColl.createIndex(key, { name: idxName, ...options });
          idxOk += 1;
        } catch (e2) {
          warn(`${dstDb.databaseName}.${name}: index ${idxName} failed — ${e2.message}`);
        }
      } else {
        warn(`${dstDb.databaseName}.${name}: index ${idxName} failed — ${err.message}`);
      }
    }
  }
  stats.indexes += idxOk;

  const flag = written === total ? '' : `   [WRITTEN ${fmt(written)} != SOURCE ${fmt(total)}]`;
  console.log(`\r    ${name.padEnd(42)} ${String(fmt(total)).padStart(9)} docs, ${idxOk}/${srcIndexes.length} idx${flag}`);
}

async function copyViews(srcDb, dstDb) {
  const views = await listViews(srcDb);
  for (const v of views) {
    stats.views += 1;
    if (!EXECUTE) {
      console.log(`    ${v.name.padEnd(42)} (view on ${v.options?.viewOn})`);
      continue;
    }
    await dstDb.collection(v.name).drop().catch(() => {});
    await dstDb.createCollection(v.name, {
      viewOn: v.options.viewOn,
      pipeline: v.options.pipeline,
      ...(v.options.collation ? { collation: v.options.collation } : {}),
    });
    console.log(`    ${v.name.padEnd(42)} (view recreated)`);
  }
}

/**
 * Point every tenant routing record at the NEW cluster.
 * Preserves each tenant's original credentials/query params? No — the whole
 * point is to move clusters, so the endpoint becomes the new cluster URI with
 * the tenant's own dbName preserved in `dbName` (the app calls useDb(dbName)).
 */
async function rewriteTenantEndpoints(client, newUri, oldUri) {
  const tenants = client.db('router').collection('tenants');
  const docs = await tenants.find({}).toArray();
  console.log(`\n  Rewriting router.tenants[].clusterEndpoint → ${mask(newUri)}`);
  let changed = 0;
  for (const t of docs) {
    const current = String(t.clusterEndpoint || '');
    if (hostOf(current) === hostOf(newUri)) {
      console.log(`    ${String(t.orgId).padEnd(32)} already on new cluster`);
      continue;
    }
    if (hostOf(current) !== hostOf(oldUri)) {
      warn(`${t.orgId}: clusterEndpoint host ${hostOf(current)} is neither old nor new cluster — left untouched`);
      continue;
    }
    if (!EXECUTE) {
      console.log(`    ${String(t.orgId).padEnd(32)} ${mask(current)}  ->  ${mask(newUri)}`);
      changed += 1;
      continue;
    }
    await tenants.updateOne(
      { _id: t._id },
      { $set: { clusterEndpoint: newUri, updatedAt: new Date() } }
    );
    console.log(`    ${String(t.orgId).padEnd(32)} updated`);
    changed += 1;
  }
  console.log(`  ${changed} tenant endpoint(s) ${EXECUTE ? 'updated' : 'would be updated'}`);
}

async function main() {
  const { source, target } = getUris();

  console.log('='.repeat(78));
  console.log(EXECUTE ? 'FULL CLUSTER MIGRATION — EXECUTING' : 'FULL CLUSTER MIGRATION — DRY RUN (no writes)');
  console.log('='.repeat(78));
  console.log(`SOURCE : ${mask(baseUri(source))}`);
  console.log(`TARGET : ${mask(baseUri(target))}`);
  if (DROP_TARGET) console.log('MODE   : --drop-target (existing target collections are dropped first)');
  if (ONLY.length) console.log(`FILTER : only ${ONLY.join(', ')}`);
  console.log('');

  const srcClient = await connect(source, 'SOURCE');
  let dstClient = null;
  try {
    dstClient = await connect(target, 'TARGET');
  } catch (err) {
    if (EXECUTE) {
      await srcClient.close();
      throw new Error(`Cannot connect to TARGET cluster: ${err.message}`);
    }
    // Dry run still produces a useful plan without the target.
    warn(`TARGET cluster unreachable (${err.codeName || err.message}) — plan shown from SOURCE only`);
  }

  try {
    let dbNames = await listUserDbs(srcClient);
    if (ONLY.length) dbNames = dbNames.filter((d) => ONLY.includes(d));
    if (!dbNames.length) throw new Error('No databases to migrate (check --only filter).');

    // router last is not required, but copy router first so tenants exist for
    // the endpoint rewrite even if a later DB fails.
    dbNames.sort((a, b) => (a === 'router' ? -1 : b === 'router' ? 1 : a.localeCompare(b)));

    for (const dbName of dbNames) {
      stats.dbs += 1;
      const srcDb = srcClient.db(dbName);
      const dstDb = dstClient ? dstClient.db(dbName) : null;
      const colls = await listCollections(srcDb);
      console.log(`\n  DB ${dbName}  (${colls.length} collections)`);
      for (const info of colls) {
        await copyCollection(srcDb, dstDb, info);
      }
      await copyViews(srcDb, dstDb);
    }

    if (!KEEP_ENDPOINTS && dbNames.includes('router')) {
      // On a dry run without a reachable target, preview from the source copy.
      await rewriteTenantEndpoints(dstClient || srcClient, target, source);
    } else if (KEEP_ENDPOINTS) {
      console.log('\n  --keep-endpoints: router.tenants[].clusterEndpoint left pointing at the OLD cluster');
    }
  } finally {
    await srcClient.close();
    if (dstClient) await dstClient.close();
  }

  console.log('\n' + '='.repeat(78));
  console.log(EXECUTE ? 'MIGRATION COMPLETE' : 'DRY RUN COMPLETE — nothing was written');
  console.log('='.repeat(78));
  console.log(`  databases   : ${stats.dbs}`);
  console.log(`  collections : ${stats.collections}`);
  console.log(`  views       : ${stats.views}`);
  console.log(`  documents   : read ${fmt(stats.docsRead)}${EXECUTE ? ` / written ${fmt(stats.docsWritten)}` : ''}`);
  console.log(`  indexes     : ${stats.indexes}`);
  if (stats.warnings.length) {
    console.log(`\n  WARNINGS (${stats.warnings.length}):`);
    stats.warnings.forEach((w) => console.log(`    - ${w}`));
  }
  if (EXECUTE) {
    console.log('\n  Next: node scripts/verifyClusterMigration.js');
    console.log('  Then: point ROUTER_DB_URI at the new cluster in .env / your host env.');
  } else {
    console.log('\n  Re-run with --execute to perform the migration.');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nMIGRATION FAILED:', err);
    process.exit(1);
  }
);
