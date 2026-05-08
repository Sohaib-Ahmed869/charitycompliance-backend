/**
 * trackApiCall — fire-and-forget middleware that bumps the apiCallsPerDay
 * counter for the current tenant on every authenticated platform request.
 *
 * Mounted as the LAST step of authAndResolveTenant so we already have
 * req.user / req.tenantDb / req.orgId. Never blocks the request — counter
 * write happens in the background, errors swallowed.
 *
 * Skips:
 *   - Calcite admins / auditors  (not customers)
 *   - billing endpoints           (would create noise + risk feedback loops)
 *   - usage endpoint              (otherwise reading usage bumps usage)
 *   - OPTIONS preflights
 *   - GETs that are pure reads of billing state
 */

import { incrementApiCall } from '../services/usageMeterService.js';

const SKIP_PATH_FRAGMENTS = [
  '/platform/billing'
];

export function trackApiCall(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!req.tenantDb || !req.orgId) return next();

  // Calcite staff don't count toward tenant API limits.
  const roles = req.user?.roles || [];
  if (Array.isArray(roles) && (roles.includes('calcite.super_admin') || roles.includes('super_admin'))) {
    return next();
  }

  const fullUrl = (req.baseUrl || '') + (req.path || '');
  if (SKIP_PATH_FRAGMENTS.some((p) => fullUrl.includes(p))) return next();

  // Fire-and-forget — don't await, don't fail the request on metering errors.
  incrementApiCall({ tenantDb: req.tenantDb, orgId: req.orgId }).catch((err) => {
    console.error('[trackApiCall] non-fatal:', err?.message || err);
  });
  return next();
}

export default trackApiCall;
