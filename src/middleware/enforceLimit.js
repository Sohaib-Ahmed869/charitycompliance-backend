/**
 * enforceLimit — middleware that gates a metered action behind the
 * tenant's plan limit. Works for any counter-based metric:
 *
 *   router.post('/expenses', enforceLimit('workflowsPerMonth'), createExpense)
 *
 * For state-based metrics (staff seats, board seats, storage), use
 * `checkAllocation()` below instead — it doesn't increment, just
 * validates a proposed new count against the tenant's limit + overage
 * policy.
 *
 * Behaviour (both paths):
 *   - At or above the hard cap, with no overage rate configured →
 *     402 LIMIT_EXCEEDED (action halted, upgrade plan to continue).
 *   - At or above the hard cap, overage rate configured, projected
 *     overage cost still within tenant's self-set hard_cap_aud →
 *     report usage to Stripe + allow (overage billed at period end).
 *   - At or above the hard cap, overage available BUT projected cost
 *     exceeds the tenant's hard_cap_aud → 402 HARD_CAP_REACHED
 *     ("raise your cap on /billing to continue").
 *   - Global kill-switch engaged → never blocks (incident mode).
 *   - Calcite SuperAdmins bypass entirely.
 *   - Soft cap (default 80%) → X-Usage-Warning header, request proceeds.
 *
 * Per-metric pricing comes from `plan.pricing.overageRatesAUD[metric]`
 * and `plan.pricing.stripeOverageMeters[metric]`. The legacy
 * `overagePerWorkflowAUD` / `stripeOverageMeterId` are still honoured
 * for `workflowsPerMonth` so existing plans keep working unchanged.
 */

import { resolveEntitlements } from '../services/entitlementService.js';
import { incrementWorkflow, incrementApiCall } from '../services/usageMeterService.js';
import { reportOverageUsage, isStripeConfigured } from '../services/stripeService.js';
import getRouterModels from '../db/models/routerModels.js';

const METRIC_TO_INCREMENT = {
  workflowsPerMonth: incrementWorkflow,
  apiCallsPerDay:    incrementApiCall
};

/**
 * Look up the per-unit overage rate (AUD) for a metric, falling back
 * to the legacy `overagePerWorkflowAUD` field for workflowsPerMonth so
 * older plans that never got the new map still work.
 */
function getOverageRate(pricing, metric) {
  if (!pricing) return 0;
  const fromMap = Number(pricing?.overageRatesAUD?.[metric]) || 0;
  if (fromMap > 0) return fromMap;
  if (metric === 'workflowsPerMonth') {
    return Number(pricing?.overagePerWorkflowAUD) || 0;
  }
  return 0;
}

/** Look up the Stripe meter Price ID for a metric, same legacy fallback. */
function getMeterPriceId(pricing, metric) {
  if (!pricing) return '';
  const fromMap = pricing?.stripeOverageMeters?.[metric] || '';
  if (fromMap) return fromMap;
  if (metric === 'workflowsPerMonth') return pricing?.stripeOverageMeterId || '';
  return '';
}

/**
 * Shared decision logic for both increment-style (`enforceLimit`) and
 * state-style (`checkAllocation`) callers. Given a new count + the
 * tenant's entitlements + the metric being checked, returns either
 * `{ allow: true, overageBilled?: bool }` or a 402-shaped error object.
 *
 * `extraUnits` — how many units of this action push the tenant over.
 * For counter metrics this is normally 1 (each increment). For
 * allocation checks (e.g. inviting a user), the caller can pass any
 * number if they want to validate an N-step move atomically.
 */
async function decide({ ent, metric, newCount, limit, orgId, extraUnits = 1 }) {
  const softPct = (ent.limits?.softCapPct ?? 80) / 100;
  const hardPct = (ent.limits?.hardCapPct ?? 100) / 100;
  const ratio = limit > 0 ? newCount / limit : 0;

  if (ratio < hardPct) {
    return {
      allow: true,
      warn: ratio >= softPct,
      newCount, limit, ratio
    };
  }

  // Global kill-switch — never block, never bill, just record.
  if (ent.overage_kill_switch) {
    return { allow: true, killSwitch: true, newCount, limit };
  }

  const overageRate = getOverageRate(ent.pricing, metric);
  // No overage configured → hard refusal.
  if (!overageRate) {
    return {
      allow: false,
      status: 402,
      error: {
        code: 'LIMIT_EXCEEDED',
        message: `You've reached your ${prettyMetric(metric)} limit (${newCount}/${limit}). Upgrade your plan to continue.`,
        details: { metric, used: newCount, cap: limit, plan: ent.plan_code, overage_available: false }
      }
    };
  }

  // Overage available — check tenant's self-set ceiling.
  const overageCount = Math.max(0, newCount - limit);
  const projectedOverageAud = overageCount * overageRate;
  if (ent.hard_cap_aud != null && projectedOverageAud > Number(ent.hard_cap_aud)) {
    return {
      allow: false,
      status: 402,
      error: {
        code: 'HARD_CAP_REACHED',
        message: `You've reached your self-set $${ent.hard_cap_aud} overage cap for ${prettyMetric(metric)}. Raise it on /billing to continue, or upgrade your plan.`,
        details: {
          metric, cap_aud: ent.hard_cap_aud, projected_aud: projectedOverageAud,
          overage_rate_aud: overageRate, used: newCount, limit
        }
      }
    };
  }

  // Bill the overage via Stripe (best effort — if reporting fails, we
  // still allow so the tenant isn't blocked by infra; the failure is
  // logged so ops can reconcile).
  if (isStripeConfigured()) {
    const meterPriceId = getMeterPriceId(ent.pricing, metric);
    const { OrganizationSubscription } = getRouterModels();
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId }).lean();
    if (sub?.stripe_subscription_id && meterPriceId) {
      const result = await reportOverageUsage({
        subscriptionId: sub.stripe_subscription_id,
        meterPriceId,
        quantity: extraUnits
      });
      if (!result.ok) {
        console.error('[enforceLimit] overage report failed:', { metric, error: result.error });
      }
      return { allow: true, overageBilled: result.ok, overageRate, projectedOverageAud };
    }
  }

  // Overage rate is set but we can't actually charge (no Stripe meter
  // configured for this metric on this plan, or no subscription). The
  // intent was "allow but bill" — without a way to bill, this becomes
  // "allow on the house and warn ops."
  console.warn('[enforceLimit] overage allowed without billing — no Stripe meter for', metric);
  return { allow: true, overageBilled: false, overageRate, projectedOverageAud };
}

function prettyMetric(metric) {
  const m = {
    workflowsPerMonth: 'workflow',
    apiCallsPerDay:    'API call',
    staffSeats:        'staff seat',
    boardSeats:        'board seat',
    storageGB:         'storage'
  };
  return m[metric] || metric;
}

/**
 * Express middleware. Increments the counter for `metric`, then calls
 * `decide()` to figure out whether to allow, warn, bill, or block.
 */
export function enforceLimit(metric) {
  if (!metric) throw new Error('enforceLimit: metric is required');
  return async (req, res, next) => {
    try {
      const orgId = req.orgId || req.user?.orgId;
      if (!orgId) return next();
      // Calcite admins bypass.
      const roles = req.user?.roles || [];
      if (Array.isArray(roles) && (roles.includes('calcite.super_admin') || roles.includes('super_admin'))) {
        return next();
      }
      const ent = await resolveEntitlements(orgId);
      const limit = ent?.limits?.[metric];
      // Unmetered → just continue. We treat several values as "no
      // enforcement for this metric":
      //   undefined / null  — the plan never set a limit
      //   -1                — explicit "unlimited"
      //   0                 — convention for "feature included without a
      //                       meter" (historically the display said
      //                       0/0 with no enforcement). Plans that want
      //                       to BLOCK access entirely should drop the
      //                       feature flag for that capability instead
      //                       of setting limit=0.
      if (limit === -1 || limit === 0 || limit === undefined || limit === null) return next();

      const incrementer = METRIC_TO_INCREMENT[metric];
      if (!incrementer) return next(); // metric not yet hooked up to a counter

      const newCount = await incrementer({ tenantDb: req.tenantDb, orgId });
      if (newCount == null) return next();

      const decision = await decide({ ent, metric, newCount, limit, orgId });
      if (!decision.allow) {
        return res.status(decision.status).json({ success: false, error: decision.error });
      }
      if (decision.warn) {
        res.setHeader('X-Usage-Warning', `${metric}:${newCount}/${limit}`);
      }
      if (decision.overageBilled) {
        res.setHeader('X-Usage-Overage', `${metric}:${newCount}/${limit}:billed`);
      } else if (decision.killSwitch) {
        res.setHeader('X-Usage-Warning', `${metric}:${newCount}/${limit}:kill-switch`);
      }
      return next();
    } catch (err) {
      // Don't block the request on metering failures — degrade open.
      console.error('[enforceLimit] non-fatal error:', err?.message || err);
      return next();
    }
  };
}

/**
 * Synchronous gate for state-based metrics (seats, storage). Call
 * BEFORE you persist the new record / accept the upload; refuse if it
 * comes back `{ allow: false, ... }`.
 *
 *   const check = await checkAllocation({ orgId, metric: 'staffSeats', proposedNewCount: currentActive + 1 });
 *   if (!check.allow) return res.status(check.status).json({ success: false, error: check.error });
 *
 * For storage uploads, `proposedNewCount` is the projected total in
 * the relevant unit — bytes for storageBytes, GB for storageGB
 * (whichever the limit is denominated in). See subscriptionPlanSchema.
 */
export async function checkAllocation({ orgId, metric, proposedNewCount, extraUnits = 1 }) {
  if (!orgId || !metric || proposedNewCount == null) {
    return { allow: true }; // misconfigured caller — degrade open
  }
  const ent = await resolveEntitlements(orgId);
  const limit = ent?.limits?.[metric];
  // See enforceLimit for the unmetered-value convention. limit=0 is
  // "feature included, no meter" — block access via feature_flags, not
  // by setting a zero limit.
  if (limit === -1 || limit === 0 || limit === undefined || limit === null) {
    return { allow: true };
  }
  return decide({ ent, metric, newCount: proposedNewCount, limit, orgId, extraUnits });
}

export default enforceLimit;
