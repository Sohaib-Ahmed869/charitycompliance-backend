/**
 * publishUsageEvent — single entry point for metering ingestion.
 *
 * Call this from a controller when a workflow reaches a terminal state
 * (approved, rejected, withdrawn, closed). Every call is idempotent on
 * the `event_id` you supply — typically `<entity_collection>:<id>:<state>`
 * so retries collapse.
 *
 * Architecture §2.3 — append-only ingestion. The aggregation worker
 * rolls these into UsageCounter every 30s; nothing in the hot path
 * touches this collection.
 *
 * Intentionally NEVER throws — metering errors must not fail the
 * underlying business action. Errors are logged and swallowed.
 */

import usageEventSchema from '../db/schemas/platform/usageEventSchema.js';
import { logError } from './logger.js';

function eventModel(tenantDb) {
  return tenantDb.models.UsageEvent || tenantDb.model('UsageEvent', usageEventSchema);
}

/**
 * @param {object} args
 * @param {import('mongoose').Connection} args.tenantDb
 * @param {string|object} args.orgId            org_id (Organization _id, ObjectId or string)
 * @param {string} args.eventCode               e.g. 'expense.approved'
 * @param {string} args.eventId                 idempotency key
 * @param {boolean} [args.countsAsWorkflow=true]
 * @param {number} [args.storageDeltaBytes=0]
 * @param {object} [args.payload={}]
 */
export async function publishUsageEvent({
  tenantDb,
  orgId,
  eventCode,
  eventId,
  countsAsWorkflow = true,
  storageDeltaBytes = 0,
  payload = {}
} = {}) {
  if (!tenantDb || !orgId || !eventCode || !eventId) {
    logError('publishUsageEvent: missing required args', null, { orgId, eventCode, eventId });
    return;
  }
  try {
    const UsageEvent = eventModel(tenantDb);
    await UsageEvent.updateOne(
      { org_id: orgId, event_id: String(eventId) },
      {
        $setOnInsert: {
          org_id: orgId,
          event_id: String(eventId),
          event_code: eventCode,
          counts_as_workflow: !!countsAsWorkflow,
          storage_delta_bytes: Number(storageDeltaBytes) || 0,
          payload: payload || {},
          ts: new Date()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    // Duplicate key (idempotency hit) is benign — anything else logs.
    if (err?.code !== 11000) {
      logError('publishUsageEvent: write failed', err, { orgId, eventCode, eventId });
    }
  }
}

export default publishUsageEvent;
