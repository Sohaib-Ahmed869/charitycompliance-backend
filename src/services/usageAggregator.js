/**
 * Usage aggregator (architecture §2.3).
 *
 * Every 30 seconds, walks every tenant connection and rolls each
 * tenant's pending UsageEvent rows (those with `aggregated_at` null)
 * into the UsageCounter doc. Stamps `aggregated_at` on the event so
 * the next pass skips it.
 *
 * Why this exists: the hot path (`requireLimitHeadroom` middleware)
 * must hit ONE document on read (UsageCounter), not scan an
 * append-only event log. So we pay the aggregation cost off-line.
 *
 * Scope note: we only aggregate for tenants whose connections are
 * already cached in `connectionManager` — we don't open new
 * connections just for the sweep. A tenant with no recent traffic
 * doesn't need real-time aggregation; their next request will fault
 * the connection in and pick up any backlog naturally.
 */

import getRouterModels from '../db/models/routerModels.js';
import { getTenantConnection } from '../db/connectionManager.js';
import usageEventSchema from '../db/schemas/platform/usageEventSchema.js';
import { logInfo, logError } from '../utils/logger.js';
import { incrementWorkflow } from './usageMeterService.js';

const SWEEP_INTERVAL_MS = 30 * 1000;
const BOOT_DELAY_MS = Number(process.env.REMINDERS_RUN_ON_BOOT_DELAY_MS) || 8000;

let _timer = null;

function eventModel(tenantDb) {
  return tenantDb.models.UsageEvent || tenantDb.model('UsageEvent', usageEventSchema);
}

/**
 * Walk every tenant once, aggregate pending events into UsageCounter,
 * stamp aggregated_at on the events.
 */
export async function runUsageAggregationOnce() {
  try {
    const { Tenant } = getRouterModels();
    const tenants = await Tenant.find({ status: 'active' }).select('orgId').lean();
    let totalEvents = 0;
    for (const t of tenants) {
      try {
        const tenantDb = await getTenantConnection(t.orgId);
        const UsageEvent = eventModel(tenantDb);

        const pending = await UsageEvent
          .find({ aggregated_at: null })
          .sort({ ts: 1 })
          .limit(500)
          .lean();

        if (pending.length === 0) continue;

        // Roll workflow events into the per-month workflowsPerMonth
        // counter via the existing incrementWorkflow helper. Storage
        // deltas could be added similarly when we wire storage gating.
        for (const evt of pending) {
          if (evt.counts_as_workflow) {
            await incrementWorkflow({ tenantDb, orgId: t.orgId });
          }
        }

        // Stamp them as aggregated.
        await UsageEvent.updateMany(
          { _id: { $in: pending.map((e) => e._id) } },
          { $set: { aggregated_at: new Date() } }
        );
        totalEvents += pending.length;
      } catch (err) {
        logError('usageAggregator: tenant sweep failed', err, { orgId: t.orgId });
      }
    }
    if (totalEvents > 0) {
      logInfo('usageAggregator: aggregated events', { totalEvents, tenants: tenants.length });
    }
    return { aggregated: totalEvents };
  } catch (err) {
    logError('usageAggregator: top-level error', err);
    return { aggregated: 0, error: err?.message || String(err) };
  }
}

export function startUsageAggregator() {
  if (_timer) return;
  setTimeout(() => { runUsageAggregationOnce().catch(() => {}); }, BOOT_DELAY_MS);
  _timer = setInterval(() => { runUsageAggregationOnce().catch(() => {}); }, SWEEP_INTERVAL_MS);
  logInfo('usageAggregator: started', { interval_ms: SWEEP_INTERVAL_MS });
}

export function stopUsageAggregator() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export default {
  startUsageAggregator,
  stopUsageAggregator,
  runUsageAggregationOnce
};
