/**
 * Policy marketplace kill switch.
 *
 * The marketplace (public marketing site + in-app policies surface) is
 * gated by a single platform-wide flag on the Router DB `admin_settings`
 * global document (`policyMarketplaceEnabled`). Only SuperAdmin can flip
 * it, from /calcite-admin/settings. Defaults to OFF when unset.
 *
 * Post-purchase paths (claim, download, reconcile, purchases) are never
 * gated — buyers who already paid keep access to their documents.
 */

import { getRouterConnection } from '../config/database.js';

const CACHE_TTL_MS = 30 * 1000;
let cached = { value: null, at: 0 };

export async function isPolicyMarketplaceEnabled() {
  const now = Date.now();
  if (cached.value !== null && now - cached.at < CACHE_TTL_MS) return cached.value;
  const col = getRouterConnection().collection('admin_settings');
  const doc = await col.findOne({ key: 'global' }, { projection: { policyMarketplaceEnabled: 1 } });
  const enabled = !!doc?.policyMarketplaceEnabled;
  cached = { value: enabled, at: now };
  return enabled;
}

export function invalidateMarketplaceGateCache() {
  cached = { value: null, at: 0 };
}

/**
 * Router-level gate. `allowPaths` is a RegExp tested against req.path;
 * matching paths bypass the switch (post-purchase surfaces).
 */
export function requireMarketplaceEnabled(allowPaths = null) {
  return async (req, res, next) => {
    try {
      if (allowPaths && allowPaths.test(req.path)) return next();
      if (await isPolicyMarketplaceEnabled()) return next();
      return res.status(404).json({
        success: false,
        error: { code: 'MARKETPLACE_DISABLED', message: 'The policy marketplace is not available.' }
      });
    } catch (err) {
      next(err);
    }
  };
}
