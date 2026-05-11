/**
 * Override expiry sweep — handbook §3.1 + architecture §11.
 *
 * SubscriptionOverride rows can have `effective_until` set so they
 * auto-expire (e.g. "give Acme 100 GB of storage until 31 Dec 2026").
 * The entitlement resolver already honours `effective_until` at read
 * time (an expired override stops merging into entitlements), but the
 * override doc itself stays in the collection until something cleans
 * it up. This service is that something:
 *
 *   - Once an hour, find every active override whose `effective_until`
 *     is in the past.
 *   - Mark it `status: 'expired'`, write a BillingEvent for the audit
 *     trail, and bust the entitlement cache for the tenant so any
 *     stale "with override" entitlements get refreshed on next request.
 *
 * Boots from `server.js` only when `BACKGROUND_JOBS_ENABLED=true`
 * (mirroring the existing reminder schedulers). Idempotent — safe to
 * fire repeatedly because the query filter excludes already-expired
 * rows.
 */

import getRouterModels from '../db/models/routerModels.js';
import { invalidateEntitlements } from './entitlementService.js';
import { logInfo, logError } from '../utils/logger.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;            // 1h
const BOOT_DELAY_MS = Number(process.env.REMINDERS_RUN_ON_BOOT_DELAY_MS) || 8000;

let _timer = null;

/** One sweep — find overrides past their expiry and flip them. */
export async function runOverrideExpiryOnce() {
  try {
    const { SubscriptionOverride, BillingEvent } = getRouterModels();
    const now = new Date();

    // We only flip overrides that were active and have JUST passed their
    // expiry. `status: { $ne: 'expired' }` skips already-flipped rows.
    const expired = await SubscriptionOverride.find({
      effective_until: { $lte: now, $ne: null },
      status: { $ne: 'expired' }
    }).lean();

    if (expired.length === 0) return { swept: 0 };

    for (const ov of expired) {
      try {
        await SubscriptionOverride.updateOne(
          { _id: ov._id },
          { $set: { status: 'expired', expired_at: now } }
        );
        await BillingEvent.create({
          action: 'subscription_override.expired',
          target_type: 'subscription_override',
          target_id: String(ov._id),
          target_label: ov.tenant_id,
          tenant_id: ov.tenant_id,
          actor_id: null,
          actor_email: 'system@stewardex',
          metadata: {
            effective_from: ov.effective_from,
            effective_until: ov.effective_until
          }
        });
        invalidateEntitlements(ov.tenant_id);
      } catch (err) {
        logError('overrideExpiry: failed to flip override', err, { id: String(ov._id), tenant: ov.tenant_id });
      }
    }
    logInfo('overrideExpiry: swept', { count: expired.length });
    return { swept: expired.length };
  } catch (err) {
    logError('overrideExpiry: sweep error', err);
    return { swept: 0, error: err?.message || String(err) };
  }
}

export function startOverrideExpiryScheduler() {
  if (_timer) return;
  // Catch-up sweep on boot.
  setTimeout(() => { runOverrideExpiryOnce().catch(() => {}); }, BOOT_DELAY_MS);
  _timer = setInterval(() => { runOverrideExpiryOnce().catch(() => {}); }, SWEEP_INTERVAL_MS);
  logInfo('overrideExpiry: scheduler started', { interval_ms: SWEEP_INTERVAL_MS });
}

export function stopOverrideExpiryScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export default {
  startOverrideExpiryScheduler,
  stopOverrideExpiryScheduler,
  runOverrideExpiryOnce
};
