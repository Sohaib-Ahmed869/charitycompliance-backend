/**
 * Cluster Migration — shared helpers
 *
 * Used by surveyClusters.js / migrateCluster.js / verifyClusterMigration.js
 * to move ALL data from the cluster in ROUTER_DB_URI to the cluster in
 * NEW_ROUTE_DB_URI (router DB + every per-tenant DB).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

export const mask = (uri) => String(uri || '').replace(/\/\/[^@]*@/, '//***@');

export function getUris() {
  let source = String(process.env.ROUTER_DB_URI || '').trim();
  const target = String(process.env.NEW_ROUTE_DB_URI || '').trim();
  const oldUri = String(process.env.OLD_ROUTER_DB_URI || '').trim();
  if (!source) throw new Error('ROUTER_DB_URI is required in .env');
  if (!target) throw new Error('NEW_ROUTE_DB_URI is required in .env');

  // After cutover ROUTER_DB_URI points at the new cluster. Fall back to
  // OLD_ROUTER_DB_URI so verification can still diff old vs new.
  if (hostOf(source) === hostOf(target) && oldUri && hostOf(oldUri) !== hostOf(target)) {
    console.log('[note] ROUTER_DB_URI is already on the new cluster — using OLD_ROUTER_DB_URI as source');
    source = oldUri;
  }
  if (hostOf(source) === hostOf(target)) {
    throw new Error('Source and target point at the same cluster host — refusing to run.');
  }
  return { source, target };
}

/** Cluster host portion of a mongodb+srv/mongodb URI (identity of the cluster). */
export function hostOf(uri) {
  const m = String(uri).match(/^mongodb(\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/i);
  return m ? m[2].toLowerCase() : String(uri);
}

/** Strip any /dbname path so the URI can be used with .db(name) for any DB. */
export function baseUri(uri) {
  const [head, query = ''] = String(uri).split('?');
  const m = head.match(/^(mongodb(?:\+srv)?:\/\/[^/]+)/i);
  const base = m ? m[1] : head.replace(/\/[^/]*$/, '');
  return query ? `${base}/?${query}` : `${base}/`;
}

export async function connect(uri, label) {
  const client = new MongoClient(baseUri(uri), {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 0,
    maxPoolSize: 10,
  });
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  console.log(`[connected] ${label}: ${mask(baseUri(uri))}`);
  return client;
}

/** All non-system database names on a cluster. */
export async function listUserDbs(client) {
  const { databases } = await client.db().admin().listDatabases();
  return databases
    .map((d) => d.name)
    .filter((n) => !SYSTEM_DBS.has(n))
    .sort();
}

/** Collections (excluding views and system.*) in a database. */
export async function listCollections(db) {
  const infos = await db.listCollections().toArray();
  return infos.filter((c) => c.type !== 'view' && !c.name.startsWith('system.'));
}

export async function listViews(db) {
  const infos = await db.listCollections().toArray();
  return infos.filter((c) => c.type === 'view');
}

export const fmt = (n) => Number(n).toLocaleString('en-US');
