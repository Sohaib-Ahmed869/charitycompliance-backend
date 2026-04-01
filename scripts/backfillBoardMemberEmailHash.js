/**
 * Backfill email_hash on board_members for duplicate-email checks (tenant DBs).
 *
 * Run from repo root: node scripts/backfillBoardMemberEmailHash.js
 */

import dotenv from 'dotenv';
import crypto from 'crypto';
import config from '../src/config/index.js';
import { getMasterKeyHex } from '../src/config/encryption.js';
import { connectRouterDB } from '../src/config/database.js';
import { getTenantConnection } from '../src/db/connectionManager.js';
import getRouterModels from '../src/db/models/routerModels.js';
import boardMemberSchema from '../src/db/schemas/platform/boardMemberSchema.js';
import { decrypt, isEncrypted } from '../src/utils/encryption.js';

dotenv.config();

function createEmailHash(email) {
  const masterKey = config.encryption.masterKeyHex;
  return crypto
    .createHmac('sha256', Buffer.from(masterKey, 'hex'))
    .update(String(email).toLowerCase().trim())
    .digest('hex');
}

async function main() {
  console.log('Backfilling board member email_hash…');
  await connectRouterDB();
  const routerModels = getRouterModels();
  const tenants = await routerModels.Tenant.find({ status: 'active' }).select({ orgId: 1 }).lean();
  const keyHex = getMasterKeyHex();
  if (!keyHex || keyHex.length !== 64) {
    console.error('MASTER_KEY_HEX missing or invalid');
    process.exit(1);
  }

  let total = 0;
  for (const tenant of tenants || []) {
    const orgId = tenant.orgId || String(tenant._id || '');
    if (!orgId) continue;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const BM = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
      const docs = await BM.collection
        .find({ is_active: true }, { projection: { email: 1, email_hash: 1 } })
        .toArray();
      let n = 0;
      for (const row of docs) {
        let plain = null;
        const enc = row.email;
        if (!enc) continue;
        try {
          plain = isEncrypted(enc) ? decrypt(enc, keyHex) : String(enc);
        } catch (e) {
          console.warn(`  ${orgId} doc ${row._id}: decrypt skip`, e.message);
          continue;
        }
        if (!plain || !String(plain).includes('@')) continue;
        const hash = createEmailHash(plain);
        if (row.email_hash === hash) continue;
        await BM.collection.updateOne({ _id: row._id }, { $set: { email_hash: hash } });
        n += 1;
      }
      if (n) console.log(`  ${orgId}: updated ${n} board member(s)`);
      total += n;
    } catch (err) {
      console.error(`  Tenant ${orgId}:`, err.message);
    }
  }
  console.log(`Done. Total documents updated: ${total}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
