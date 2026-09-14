/**
 * Finance checklist auto-generation scheduler.
 *
 * Creates month-end and quarter-end checklist instances and approval workflows.
 * Uses Router DB to enumerate organizations (similar pattern to other schedulers).
 */

import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { ChecklistService } from './checklistService.js';
import { logError, logInfo } from '../utils/logger.js';

const HOUR_MS = 60 * 60 * 1000;
const TICK_MS = Number(process.env.FINANCE_CLOSE_TICK_MS) || (6 * HOUR_MS);

function utcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
}

function isFirstOfMonthUTC(d) {
  return d.getUTCDate() === 1;
}

function prevMonth({ year, month }) {
  const m = month - 1;
  if (m >= 1) return { year, month: m };
  return { year: year - 1, month: 12 };
}

function prevQuarter({ year, quarter }) {
  const q = quarter - 1;
  if (q >= 1) return { year, quarter: q };
  return { year: year - 1, quarter: 4 };
}

function quarterForMonth(m) {
  if (m <= 3) return 1;
  if (m <= 6) return 2;
  if (m <= 9) return 3;
  return 4;
}

async function listOrgIdsFromRouterDb() {
  const routerDb = await getRouterConnection();
  // Router DB contains Organizations collection (router-level) used by tenantResolver
  const orgs = await routerDb.collection('organizations').find({}).project({ org_id: 1 }).toArray();
  return (orgs || [])
    .map((o) => String(o.org_id || '').toLowerCase().trim())
    .filter(Boolean);
}

export async function runFinanceCloseSchedulerOnce() {
  const day = utcToday();
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth() + 1;
  const quarter = quarterForMonth(month);

  // Trigger after a period ends (first day of next period) to avoid timezone edge cases
  const shouldGenerateMonthEnd = isFirstOfMonthUTC(day);
  const shouldGenerateQuarterEnd = shouldGenerateMonthEnd && ([1, 4, 7, 10].includes(month)); // first month of a quarter

  if (!shouldGenerateMonthEnd && !shouldGenerateQuarterEnd) return;

  const orgIds = await listOrgIdsFromRouterDb();
  if (orgIds.length === 0) return;

  for (const orgId of orgIds) {
    try {
      // Ensure tenant is connectable; if not, skip.
      await getTenantConnection(orgId);
      const service = new ChecklistService(orgId);

      if (shouldGenerateMonthEnd) {
        const p = prevMonth({ year, month });
        await service.createInstanceFromTemplate({ type: 'month_end', year: p.year, month: p.month }, null);
        // Monthly compliance register for the month that just closed.
        try {
          await service.createMonthlyComplianceInstance({ year: p.year, month: p.month }, null);
        } catch (err) {
          logError('Monthly compliance instance creation failed', { orgId, error: err?.message });
        }
      }
      if (shouldGenerateQuarterEnd) {
        const p = prevQuarter({ year, quarter });
        await service.createInstanceFromTemplate({ type: 'quarter_end', year: p.year, quarter: p.quarter }, null);
      }

    } catch (err) {
      logError('Finance close scheduler org tick failed', { orgId, error: err?.message });
    }
  }

  logInfo('Finance close scheduler run complete', { shouldGenerateMonthEnd, shouldGenerateQuarterEnd, orgCount: orgIds.length });
}

export function startFinanceCloseScheduler() {
  const enabled = String(process.env.FINANCE_CLOSE_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logInfo('Finance close scheduler disabled');
    return;
  }

  const tick = async () => {
    try {
      await runFinanceCloseSchedulerOnce();
    } catch (err) {
      logError('Finance close scheduler tick failed', { error: err?.message });
    }
  };

  // run once shortly after boot
  setTimeout(() => tick(), Number(process.env.FINANCE_CLOSE_RUN_ON_BOOT_DELAY_MS) || 12000);
  setInterval(tick, TICK_MS);
}

