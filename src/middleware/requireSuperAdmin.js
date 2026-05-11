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
const BILLING_ROLES   = ['calcite.billing_operator', 'billing_operator'];
const SUPPORT_ROLES   = ['calcite.support_agent', 'support_agent'];
const ALL_CALCITE     = [...SUPERADMIN_ROLES, ...BILLING_ROLES, ...SUPPORT_ROLES];

function rolesOf(req) {
  return Array.isArray(req.user?.roles) ? req.user.roles : [];
}

function unauth(res) {
  return res.status(401).json({
    success: false,
    error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' }
  });
}

function forbid(res, code, message) {
  return res.status(403).json({ success: false, error: { code, message } });
}

/** Strict — only super_admin. Used for plan editing, settings, staff CRUD. */
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user) return unauth(res);
  if (!rolesOf(req).some((r) => SUPERADMIN_ROLES.includes(r))) {
    return forbid(res, 'SUPERADMIN_REQUIRED', 'This action requires Calcite super administrator role.');
  }
  next();
};

/** Any Calcite staff — super_admin / billing_operator / support_agent. */
export const requireCalciteStaff = (req, res, next) => {
  if (!req.user) return unauth(res);
  if (!rolesOf(req).some((r) => ALL_CALCITE.includes(r))) {
    return forbid(res, 'CALCITE_STAFF_REQUIRED', 'This area is restricted to Calcite staff.');
  }
  next();
};

/** super_admin OR billing_operator — invoice / payment / coupon ops. */
export const requireBillingStaff = (req, res, next) => {
  if (!req.user) return unauth(res);
  const roles = rolesOf(req);
  const allowed = roles.some((r) => SUPERADMIN_ROLES.includes(r) || BILLING_ROLES.includes(r));
  if (!allowed) return forbid(res, 'BILLING_STAFF_REQUIRED', 'This action requires billing-operator or super-admin.');
  next();
};

/** super_admin OR support_agent — ticket triage, support-context tenant reads. */
export const requireSupportStaff = (req, res, next) => {
  if (!req.user) return unauth(res);
  const roles = rolesOf(req);
  const allowed = roles.some((r) => SUPERADMIN_ROLES.includes(r) || SUPPORT_ROLES.includes(r));
  if (!allowed) return forbid(res, 'SUPPORT_STAFF_REQUIRED', 'This action requires support-agent or super-admin.');
  next();
};

export default requireSuperAdmin;
