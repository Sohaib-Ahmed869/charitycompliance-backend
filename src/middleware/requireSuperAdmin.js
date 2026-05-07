/**
 * SuperAdmin gate for the Calcite-side admin portal.
 *
 * Mounted on /api/v1/admin/* — runs after `authenticate` and asserts that
 * the user holds the `calcite.super_admin` role (or the legacy 'super_admin'
 * shorthand). Anything that fails this check returns 403 with a structured
 * code so the frontend can redirect cleanly.
 *
 * Intentionally separate from the existing tenant rbac.js — admin access
 * is a different blast radius and the gate should be obviously distinct.
 */

const SUPERADMIN_ROLES = ['calcite.super_admin', 'super_admin'];

export const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' }
    });
  }

  const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
  const isSuperAdmin = roles.some((r) => SUPERADMIN_ROLES.includes(r));

  if (!isSuperAdmin) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'SUPERADMIN_REQUIRED',
        message: 'This area is restricted to Calcite super administrators.'
      }
    });
  }

  next();
};

export default requireSuperAdmin;
