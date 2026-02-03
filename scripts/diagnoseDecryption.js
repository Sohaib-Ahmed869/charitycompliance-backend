/**
 * Diagnostic script: verify master-key decryption for a tenant's user data.
 * All field encryption now uses MASTER_KEY_HEX.
 *
 * Usage: node scripts/diagnoseDecryption.js <orgId>
 * Example: node scripts/diagnoseDecryption.js shahid_afridi_foundation
 */

import dotenv from 'dotenv';
import { connectRouterDB, closeRouterDB, getRouterConnection } from '../src/config/database.js';
import { getMasterKeyHex } from '../src/config/encryption.js';
import { decrypt, isEncrypted } from '../src/utils/encryption.js';
import mongoose from 'mongoose';

dotenv.config();

const orgId = process.argv[2];
if (!orgId) {
  console.error('Usage: node scripts/diagnoseDecryption.js <orgId>');
  process.exit(1);
}

const normalizedOrgId = orgId.toLowerCase().trim();

async function run() {
  try {
    await connectRouterDB();
    const routerDB = getRouterConnection();
    const tenant = await routerDB.collection('tenants').findOne({ orgId: normalizedOrgId, status: 'active' });
    await closeRouterDB();

    if (!tenant) {
      console.error('Tenant not found or inactive:', normalizedOrgId);
      process.exit(1);
    }

    const keyHex = getMasterKeyHex();
    if (!keyHex || keyHex.length !== 64) {
      console.error('MASTER_KEY_HEX missing or invalid (need 64 hex chars)');
      process.exit(1);
    }
    console.log('MASTER_KEY_HEX length:', keyHex.length);

    const conn = await mongoose.createConnection(tenant.clusterEndpoint).asPromise();
    const user = await conn.useDb(tenant.dbName).db.collection('users').findOne();
    await conn.close();

    if (!user) {
      console.log('No user in tenant DB.');
      process.exit(0);
    }

    console.log('User _id:', user._id);
    const fields = ['email', 'first_name', 'last_name'];
    for (const path of fields) {
      const val = user[path];
      if (val == null) continue;
      const encrypted = isEncrypted(val);
      console.log(`  ${path}: encrypted=${encrypted}, length=${val?.length}`);
      if (encrypted) {
        try {
          const decrypted = decrypt(val, keyHex);
          console.log(`    -> OK: "${decrypted.substring(0, 40)}..."`);
        } catch (e) {
          console.error(`    -> FAIL: ${e.message}`);
        }
      }
    }
    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { await closeRouterDB(); } catch (_) {}
    process.exit(1);
  }
}

run();
