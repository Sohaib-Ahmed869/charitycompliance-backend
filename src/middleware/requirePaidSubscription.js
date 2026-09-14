/**
 * requirePaidSubscription — blocks all platform actions when the tenant
 * has no paid (or comped) subscription.
 *
 * Designed to mount on /api/v1/platform/* AFTER authAndResolveTenant has
 * already populated req.user and req.orgId. The middleware short-circuits
 * a curated allow-list of paths that the tenant MUST be able to reach
 * even when they haven't paid (the billing page itself, onboarding so
 * they can finish profile, MFA setup, the dashboard read for context).
 *
 * Returns 402 SUBSCRIPTION_REQUIRED — frontend redirects to
 * /billing?payment=required automatically.
 */

import { resolveEntitlements } from '../services/entitlementService.js';

// Paths (path prefixes) that work without payment. Everything else is gated.
const ALWAYS_ALLOWED = [
  '/billing',
  '/onboarding',
  '/organization',         // owner can edit org info
  '/auth',                 // mfa, profile, etc.
  '/users/me'              // /platform/users (current user info) read
];

const READ_ALLOWED_PATHS = [
  '/dashboard'             // dashboard reads stay open so tenants can see they're locked out
];

function isPathAllowed(req) {
  // req.baseUrl is the prefix we mounted under (e.g. '/api/v1/platform/billing')
  // req.path is the rest of the URL.
  const fullUrl = (req.baseUrl || '') + (req.path || '');
  // Strip the /api/v1/platform prefix for comparison.
  const stripped = fullUrl.replace(/^\/api\/v1\/platform/, '');

  if (ALWAYS_ALLOWED.some((prefix) => stripped.startsWith(prefix))) return true;
  if (req.method === 'GET' && READ_ALLOWED_PATHS.some((prefix) => stripped.startsWith(prefix))) return true;
  return false;
}

export async function requirePaidSubscription(req, res, next) {
  try {
    // Skip if not yet authenticated (other middleware will reject) or no orgId.
    const orgId = req.orgId || req.user?.orgId;
    if (!orgId) return next();

    // Calcite admins bypass.
    if (Array.isArray(req.user?.roles) && (req.user.roles.includes('calcite.super_admin') || req.user.roles.includes('super_admin'))) {
      return next();
    }
    // Support sessions bypass — fixing payment issues is a key reason
    // support would be in here in the first place; paywalling support out
    // of a delinquent tenant defeats the purpose.
    if (req.user?.supportSession) return next();
    // Auditors bypass — they're already read-only and don't pay.
    if (req.user?.is_auditor === true) return next();

    if (isPathAllowed(req)) return next();

    const ent = await resolveEntitlements(orgId);
    if (!ent?.payment_required) return next();

    return res.status(402).json({
      success: false,
      error: {
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'Your organisation needs an active subscription to use this feature.',
        details: {
          status: ent?.status || 'no_subscription',
          plan_code: ent?.plan_code || null,
          is_comp: !!ent?.is_comp
        }
      }
    });
  } catch (err) {
    // Don't lock the tenant out because the resolver hiccupped — degrade open.
    console.error('[requirePaidSubscription] non-fatal error:', err?.message || err);
    return next();
  }
}

export default requirePaidSubscription;
