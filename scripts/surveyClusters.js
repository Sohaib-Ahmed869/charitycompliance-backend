/**
 * Survey both clusters (read-only).
 *
 *   node scripts/surveyClusters.js
 *
 * Prints every database, collection, document count and index count on the
 * source (ROUTER_DB_URI) and target (NEW_ROUTE_DB_URI) clusters, plus the
 * tenant routing table so you can see which cluster each tenant points at.
 */

import { connect, getUris, listCollections, listViews, listUserDbs, mask, fmt } from './clusterMigrationLib.js';

async function surveyCluster(label, uri) {
  const client = await connect(uri, label);
  const dbNames = await listUserDbs(client);
  console.log(`\n===== ${label} =====`);
  console.log(`host: ${mask(uri)}`);

  let totalColls = 0;
  let totalDocs = 0;
  const perDb = [];

  for (const dbName of dbNames) {
    const db = client.db(dbName);
    const colls = await listCollections(db);
    const views = await listViews(db);
    let dbDocs = 0;
    const rows = [];
    for (const c of colls) {
      const count = await db.collection(c.name).countDocuments();
      const indexes = await db.collection(c.name).indexes();
      dbDocs += count;
      totalColls += 1;
      rows.push(`    ${c.name.padEnd(42)} docs=${String(fmt(count)).padStart(9)}  idx=${indexes.length}`);
    }
    for (const v of views) rows.push(`    ${v.name.padEnd(42)} (view)`);
    totalDocs += dbDocs;
    perDb.push({ dbName, colls: colls.length, docs: dbDocs });
    console.log(`\n  DB ${dbName}  collections=${colls.length} views=${views.length} docs=${fmt(dbDocs)}`);
    if (rows.length) console.log(rows.join('\n'));
  }

  console.log(`\n  TOTAL ${label}: databases=${dbNames.length} collections=${totalColls} documents=${fmt(totalDocs)}`);
  await client.close();
  return { dbNames, perDb, totalColls, totalDocs };
}

async function main() {
  const { source, target } = getUris();
  const src = await surveyCluster('SOURCE (ROUTER_DB_URI)', source);
  const dst = await surveyCluster('TARGET (NEW_ROUTE_DB_URI)', target);

  // Tenant routing table on the source router DB
  const client = await connect(source, 'source(router)');
  try {
    const tenants = await client
      .db('router')
      .collection('tenants')
      .find({}, { projection: { orgId: 1, dbName: 1, clusterEndpoint: 1, status: 1 } })
      .toArray();
    console.log(`\n===== router.tenants (${tenants.length} entries) =====`);
    for (const t of tenants) {
      console.log(
        `  ${String(t.orgId).padEnd(32)} db=${String(t.dbName).padEnd(32)} status=${String(t.status).padEnd(10)} endpoint=${mask(t.clusterEndpoint)}`
      );
    }
    const orphanDbs = src.dbNames.filter(
      (d) => d !== 'router' && !tenants.some((t) => t.dbName === d)
    );
    if (orphanDbs.length) {
      console.log(`\n  NOTE: databases on source with no tenants entry: ${orphanDbs.join(', ')}`);
    }
    const missingDbs = tenants.map((t) => t.dbName).filter((d) => !src.dbNames.includes(d));
    if (missingDbs.length) {
      console.log(`  NOTE: tenants entries whose dbName does not exist on source: ${missingDbs.join(', ')}`);
    }
  } finally {
    await client.close();
  }

  console.log(
    `\nSUMMARY  source: ${src.dbNames.length} dbs / ${src.totalColls} colls / ${fmt(src.totalDocs)} docs` +
    `   target: ${dst.dbNames.length} dbs / ${dst.totalColls} colls / ${fmt(dst.totalDocs)} docs`
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nSURVEY FAILED:', err);
    process.exit(1);
  }
);
