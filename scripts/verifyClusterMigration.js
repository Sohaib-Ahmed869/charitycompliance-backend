/**
 * Verify a full cluster migration (read-only).
 *
 *   node scripts/verifyClusterMigration.js
 *   node scripts/verifyClusterMigration.js --deep     # also hash every document
 *
 * Compares source (ROUTER_DB_URI) against target (NEW_ROUTE_DB_URI):
 *   - every database present
 *   - every collection present
 *   - exact document counts match
 *   - index sets match (by name)
 *   - --deep: md5 over sorted _id + full BSON of each doc, per collection
 *   - router.tenants[].clusterEndpoint now points at the new cluster
 *
 * Exits non-zero if anything mismatches.
 */

import crypto from 'crypto';
import { BSON } from 'mongodb';
import {
  connect,
  getUris,
  listCollections,
  listViews,
  listUserDbs,
  hostOf,
  mask,
  fmt,
} from './clusterMigrationLib.js';

const DEEP = process.argv.includes('--deep');
const problems = [];
const fail = (msg) => {
  problems.push(msg);
  console.log(`    FAIL  ${msg}`);
};

/**
 * Fields the migration intentionally rewrites, so they must be excluded from
 * the content checksum or router.tenants would always "mismatch".
 */
const OMIT_FROM_CHECKSUM = {
  'router.tenants': ['clusterEndpoint', 'updatedAt'],
};

async function checksum(db, name) {
  const omit = OMIT_FROM_CHECKSUM[`${db.databaseName}.${name}`] || [];
  const hash = crypto.createHash('md5');
  const cursor = db.collection(name).find({}).sort({ _id: 1 }).batchSize(500);
  for await (const doc of cursor) {
    for (const f of omit) delete doc[f];
    hash.update(BSON.serialize(doc));
  }
  return hash.digest('hex');
}

async function main() {
  const { source, target } = getUris();
  console.log('='.repeat(78));
  console.log(`MIGRATION VERIFICATION${DEEP ? ' (deep — document checksums)' : ''}`);
  console.log('='.repeat(78));
  console.log(`SOURCE : ${mask(source)}`);
  console.log(`TARGET : ${mask(target)}\n`);

  const srcClient = await connect(source, 'SOURCE');
  const dstClient = await connect(target, 'TARGET');

  try {
    const srcDbs = await listUserDbs(srcClient);
    const dstDbs = await listUserDbs(dstClient);

    for (const dbName of srcDbs) {
      console.log(`\n  DB ${dbName}`);
      if (!dstDbs.includes(dbName)) {
        fail(`database ${dbName} missing on target`);
        continue;
      }
      const srcDb = srcClient.db(dbName);
      const dstDb = dstClient.db(dbName);

      const srcColls = await listCollections(srcDb);
      const dstCollNames = new Set((await listCollections(dstDb)).map((c) => c.name));

      for (const c of srcColls) {
        if (!dstCollNames.has(c.name)) {
          fail(`${dbName}.${c.name} missing on target`);
          continue;
        }
        const sCount = await srcDb.collection(c.name).countDocuments();
        const dCount = await dstDb.collection(c.name).countDocuments();
        const sIdx = (await srcDb.collection(c.name).indexes()).map((i) => i.name).sort();
        const dIdx = (await dstDb.collection(c.name).indexes()).map((i) => i.name).sort();
        const missingIdx = sIdx.filter((n) => !dIdx.includes(n));

        let line = `    ${c.name.padEnd(42)} ${String(fmt(sCount)).padStart(9)} -> ${String(fmt(dCount)).padStart(9)}  idx ${sIdx.length}->${dIdx.length}`;

        if (sCount !== dCount) {
          console.log(line);
          fail(`${dbName}.${c.name} count mismatch: source ${fmt(sCount)} vs target ${fmt(dCount)}`);
          continue;
        }
        if (missingIdx.length) {
          console.log(line);
          fail(`${dbName}.${c.name} missing indexes on target: ${missingIdx.join(', ')}`);
          continue;
        }
        if (DEEP) {
          const [sh, dh] = await Promise.all([checksum(srcDb, c.name), checksum(dstDb, c.name)]);
          if (sh !== dh) {
            console.log(line);
            fail(`${dbName}.${c.name} content checksum mismatch (${sh} vs ${dh})`);
            continue;
          }
          line += `  md5 ${sh.slice(0, 8)} OK`;
        }
        console.log(`${line}  OK`);
      }

      // views
      const srcViews = await listViews(srcDb);
      const dstViewNames = new Set((await listViews(dstDb)).map((v) => v.name));
      for (const v of srcViews) {
        if (!dstViewNames.has(v.name)) fail(`${dbName} view ${v.name} missing on target`);
        else console.log(`    ${v.name.padEnd(42)} (view)  OK`);
      }
    }

    // Tenant routing check
    console.log('\n  router.tenants routing');
    const tenants = await dstClient.db('router').collection('tenants').find({}).toArray();
    if (!tenants.length) fail('router.tenants is empty on target');
    for (const t of tenants) {
      const onNew = hostOf(t.clusterEndpoint) === hostOf(target);
      const label = `    ${String(t.orgId).padEnd(32)} -> ${hostOf(t.clusterEndpoint)}`;
      if (onNew) console.log(`${label}  OK`);
      else fail(`tenant ${t.orgId} clusterEndpoint still points at ${hostOf(t.clusterEndpoint)}`);
      // Does the tenant's database exist on target? Only a migration failure if
      // it existed on the SOURCE — a tenant record whose DB was never created
      // (org registered but never provisioned) is a pre-existing orphan.
      if (!dstDbs.includes(t.dbName)) {
        if (srcDbs.includes(t.dbName)) {
          fail(`tenant ${t.orgId}: database ${t.dbName} existed on source but is missing on target`);
        } else {
          console.log(`    ${' '.repeat(32)}    note: ${t.dbName} has no data on EITHER cluster (orphan tenant record, pre-existing)`);
        }
      }
    }
  } finally {
    await srcClient.close();
    await dstClient.close();
  }

  console.log('\n' + '='.repeat(78));
  if (problems.length) {
    console.log(`VERIFICATION FAILED — ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log('VERIFICATION PASSED — target cluster matches source.');
  console.log('='.repeat(78));
}

main().catch((err) => {
  console.error('\nVERIFICATION ERROR:', err);
  process.exit(1);
});
