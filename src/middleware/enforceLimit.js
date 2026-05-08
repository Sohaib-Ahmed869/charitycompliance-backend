/**
 * enforceLimit — middleware that gates a metered action behind the
 * tenant's plan limit. Currently supports `workflowsPerMonth`; the same
 * shape extends to apiCallsPerDay etc.
 *
 *   router.post('/expenses', enforceLimit('workflowsPerMonth'), createExpense)
 *
 * Behaviour:
 *   - Increments the counter for the current period.
 *   - If new count is over the hard cap, returns 402 LIMIT_EXCEEDED.
 *   - If new count is over the soft cap, sets X-Usage-Warning header
 *     so the FE can surface a banner; request still proceeds.
 *   - Calcite SuperAdmins bypass.
 *   - Global kill-switch (`overagesGloballyDisabled`) suppresses the
 *     hard-cap block — count is still recorded but request never 402s.
 */

import { resolveEntitlements } from '../services/entitlementService.js';
import { incrementWorkflow } from '../services/usageMeterService.js';
import { reportOverageUsage, isStripeConfigured } from '../services/stripeService.js';
import getRouterModels from '../db/models/routerModels.js';

const METRIC_TO_INCREMENT = {
  workflowsPerMonth: incrementWorkflow
};

export function enforceLimit(metric) {
  if (!metric) throw new Error('enforceLimit: metric is required');
  return async (req, res, next) => {
    try {
      const orgId = req.orgId || req.user?.orgId;
      if (!orgId) return next();
      // Calcite admins bypass.
      if (Array.isArray(req.user?.roles) && (req.user.roles.includes('calcite.super_admin') || req.user.roles.includes('super_admin'))) {
        return next();
      }
      const ent = await resolveEntitlements(orgId);
      const limit = ent?.limits?.[metric];
      // Unlimited or unmetered → just continue.
      if (limit === -1 || limit === undefined || limit === null) return next();

      const incrementer = METRIC_TO_INCREMENT[metric];
      if (!incrementer) return next(); // metric not yet hooked up to a counter

      const newCount = await incrementer({ tenantDb: req.tenantDb, orgId });
      if (newCount == null) return next();

      const softPct = (ent.limits.softCapPct ?? 80) / 100;
      const hardPct = (ent.limits.hardCapPct ?? 100) / 100;
      const ratio = limit > 0 ? newCount / limit : 0;

      // Hard cap behaviour depends on whether the plan offers overage:
      //   - overagePerWorkflowAUD set + Stripe configured → REPORT usage,
      //     don't block. Stripe bills the overage at period end.
      //   - kill-switch engaged → don't block, don't report (incident mode).
      //   - otherwise → 402 LIMIT_EXCEEDED.
      if (ratio >= hardPct) {
        if (ent.overage_kill_switch) {
          res.setHeader('X-Usage-Warning', `${metric}:${newCount}/${limit}:kill-switch`);
          return next();
        }

        const overageRate = ent.pricing?.overagePerWorkflowAUD;
        const overageEnabled = overageRate != null && Number(overageRate) > 0;

        if (overageEnabled && metric === 'workflowsPerMonth' && isStripeConfigured()) {
          // Report usage to Stripe — degrade open if reporting fails.
          const { OrganizationSubscription, SubscriptionPlan } = getRouterModels();
          const sub = await OrganizationSubscription.findOne({ organization_id: orgId }).lean();
          const plan = sub?.plan_id ? await SubscriptionPlan.findById(sub.plan_id).lean() : null;
          const meterPriceId = plan?.pricing?.stripeOverageMeterId;
          if (sub?.stripe_subscription_id && meterPriceId) {
            const result = await reportOverageUsage({
              subscriptionId: sub.stripe_subscription_id,
              meterPriceId,
              quantity: 1
            });
            if (result.ok) {
              res.setHeader('X-Usage-Overage', `${metric}:${newCount}/${limit}:billed`);
              return next();
            }
            console.error('[enforceLimit] overage report failed:', result.error);
            // Reporting failed — fall through to block as a safety net.
          }
        }

        return res.status(402).json({
          success: false,
          error: {
            code: 'LIMIT_EXCEEDED',
            message: `You've reached your ${metric} limit (${newCount}/${limit}). Upgrade your plan to continue.`,
            details: { limit: metric, used: newCount, cap: limit, plan: ent.plan_code }
          }
        });
      }
      // Soft cap → warn via header.
      if (ratio >= softPct) {
        res.setHeader('X-Usage-Warning', `${metric}:${newCount}/${limit}`);
      }
      return next();
    } catch (err) {
      // Don't block the request on metering failures — degrade open.
      console.error('[enforceLimit] non-fatal error:', err?.message || err);
      return next();
    }
  };
}

export default enforceLimit;
