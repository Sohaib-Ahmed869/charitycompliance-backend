/**
 * enforceSeatLimit — gate user / board-member creation behind the tenant's
 * seat cap, with overage support.
 *
 *   router.post('/board-members', enforceSeatLimit('boardSeats'), createBoardMember);
 *
 * Behaviour (mirrors enforceLimit so the FE handles them with one code path):
 *   - cap=0 / cap=null → no seats included → 402 SEAT_LIMIT_REACHED.
 *   - within cap → pass.
 *   - over cap, no overage rate configured → 402 LIMIT_EXCEEDED.
 *   - over cap, overage rate set, within tenant's hard_cap_aud →
 *     report usage to Stripe, allow.
 *   - over cap, overage available, projected cost > tenant cap →
 *     402 HARD_CAP_REACHED.
 *   - On metering / Stripe errors, degrades open so operational
 *     issues never lock a tenant out of seat management.
 */

import { checkAllocation } from './enforceLimit.js';

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
      const current = await req.tenantDb.collection(cfg.collection).countDocuments(cfg.filter).catch(() => 0);
      const proposedNewCount = current + 1;

      const decision = await checkAllocation({ orgId, metric, proposedNewCount });
      if (!decision.allow) {
        return res.status(decision.status || 402).json({ success: false, error: decision.error });
      }
      if (decision.overageBilled) {
        res.setHeader('X-Usage-Overage', `${metric}:${proposedNewCount}:billed`);
      }
      return next();
    } catch (err) {
      console.error('[enforceSeatLimit] non-fatal error:', err?.message || err);
      return next();
    }
  };
}

export default enforceSeatLimit;
