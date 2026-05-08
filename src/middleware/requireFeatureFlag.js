/**
 * requireFeatureFlag — gate a route behind a feature flag from the
 * tenant's effective entitlements (plan + override). Apply BEFORE the
 * route handler.
 *
 *   router.use('/partner-vetting', requireFeatureFlag('partner_vetting'));
 *
 * Returns 403 with code FEATURE_NOT_INCLUDED if the tenant's plan/override
 * does not enable the flag. Frontend uses the code to surface an upgrade
 * nudge instead of a generic forbidden screen.
 */

import { resolveEntitlements } from '../services/entitlementService.js';

export function requireFeatureFlag(flagCode) {
  if (!flagCode) throw new Error('requireFeatureFlag: flagCode is required');
  return async (req, res, next) => {
    try {
      const orgId = req.orgId || req.user?.orgId;
      if (!orgId) {
        return res.status(400).json({
          success: false,
          error: { code: 'ORG_REQUIRED', message: 'Tenant context missing.' }
        });
      }
      // Calcite admins bypass — they're not tenants.
      if (Array.isArray(req.user?.roles) && (req.user.roles.includes('calcite.super_admin') || req.user.roles.includes('super_admin'))) {
        return next();
      }
      const ent = await resolveEntitlements(orgId);
      if (ent?.feature_flags?.[flagCode]) return next();
      return res.status(403).json({
        success: false,
        error: {
          code: 'FEATURE_NOT_INCLUDED',
          message: `Your plan does not include this feature.`,
          details: { feature: flagCode, plan: ent?.plan_code || null }
        }
      });
    } catch (err) {
      next(err);
    }
  };
}

export default requireFeatureFlag;
