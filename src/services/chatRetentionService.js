/**
 * Chat Retention Sweep
 *
 * Daily sweep that walks every tenant DB and asks the chat repository to
 * purge expired attachments / message bodies from any channel that has a
 * non-zero `retention_days`. Errors per-tenant are logged but never crash
 * the loop.
 */

import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { ChatRepository } from '../repositories/chatRepository.js';
import { logError, logInfo } from '../utils/logger.js';

const TICK_MS = Number(process.env.CHAT_RETENTION_TICK_MS) || 24 * 60 * 60 * 1000;

async function listOrgIdsFromRouterDb() {
  const routerDb = await getRouterConnection();
  const orgs = await routerDb.collection('organizations').find({}).project({ org_id: 1 }).toArray();
  return (orgs || []).map((o) => String(o.org_id || '').trim()).filter(Boolean);
}

export async function runChatRetentionSweepOnce() {
  const orgIds = await listOrgIdsFromRouterDb();
  let totals = { tenants: 0, attachmentsRemoved: 0, messagesPurged: 0 };
  for (const orgId of orgIds) {
    try {
      const tenantDb = await getTenantConnection(orgId);
      const repo = new ChatRepository(tenantDb);
      const r = await repo.runRetentionSweep();
      totals.tenants += 1;
      totals.attachmentsRemoved += r.attachmentsRemoved;
      totals.messagesPurged += r.messagesPurged;
    } catch (err) {
      logError('Chat retention sweep failed for tenant', { orgId, error: err?.message });
    }
  }
  logInfo('Chat retention sweep complete', totals);
  return totals;
}

export function startChatRetentionScheduler() {
  const enabled = String(process.env.CHAT_RETENTION_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logInfo('Chat retention scheduler disabled');
    return;
  }
  setInterval(() => {
    runChatRetentionSweepOnce().catch((err) => logError('Chat retention tick failed', err));
  }, TICK_MS);
  logInfo('Chat retention scheduler started', { tickMs: TICK_MS });
}
