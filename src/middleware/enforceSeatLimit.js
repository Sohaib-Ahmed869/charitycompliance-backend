/**
 * enforceSeatLimit — gate user/board-member creation behind the tenant's
 * seat cap. Reads current active count from the tenant DB and refuses the
 * new addition if it would exceed the cap.
 *
 *   router.post('/board-members', enforceSeatLimit('boardSeats'), createBoardMember);
 *
 * Returns 402 SEAT_LIMIT_REACHED when capped (so the FE interceptor routes
 * to /billing automatically). Calcite admins + unlimited (-1) plans pass.
 * On metering errors, degrades open (don't break tenant operations because
 * a counter query failed).
 */

import { resolveEntitlements } from '../services/entitlementService.js';

const SEAT_TO_COLLECTION = {
  staffSeats: { collection: 'users',         filter: { status: 'active' }, label: 'staff seats' },
  boardSeats: { collection: 'board_members', filter: { status: 'active' }, label: 'board seats' }
};

export function enforceSeatLimit(metric) {
  if (!metric) throw new Error('enforceSeatLimit: metric is required');
  const cfg = SEAT_TO_COLLECTION[metric];
  if (!cfg) throw new Error(`enforceSeatLimit: unknown seat metric "${metric}"`);

  return async (req, res, next) => {
    try {
      const orgId = req.orgId || req.user?.orgId;
      if (!orgId || !req.tenantDb) return next();
      // Calcite admins bypass.
      if (Array.isArray(req.user?.roles) && (req.user.roles.includes('calcite.super_admin') || req.user.roles.includes('super_admin'))) {
        return next();
      }
      const ent = await resolveEntitlements(orgId);
      const cap = ent?.limits?.[metric];
      if (cap === -1 || cap === undefined || cap === null) return next();
      if (cap <= 0) {
        return res.status(402).json({
          success: false,
          error: {
            code: 'SEAT_LIMIT_REACHED',
            message: `Your plan does not include ${cfg.label}.`,
            details: { limit: metric, cap, plan: ent.plan_code }
          }
        });
      }
      const current = await req.tenantDb.collection(cfg.collection).countDocuments(cfg.filter).catch(() => 0);
      if (current >= cap) {
        return res.status(402).json({
          success: false,
          error: {
            code: 'SEAT_LIMIT_REACHED',
            message: `You've used all ${cap} ${cfg.label}. Upgrade your plan or remove an inactive member to add more.`,
            details: { limit: metric, used: current, cap, plan: ent.plan_code }
          }
        });
      }
      return next();
    } catch (err) {
      console.error('[enforceSeatLimit] non-fatal error:', err?.message || err);
      return next();
    }
  };
}

export default enforceSeatLimit;
