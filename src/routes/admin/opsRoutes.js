/**
 * SuperAdmin operational routes — Tenants, Subscriptions, Overrides,
 * Coupons, Audit (BillingEvent stream), Settings.
 *
 * One file because each surface is small. Splits when complexity earns it.
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { body, param, query } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin, requireCalciteStaff, requireBillingStaff, requireSupportStaff } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
import { invalidateEntitlements, invalidateAllEntitlements, resolveEntitlements } from '../../services/entitlementService.js';
import { validateOverride } from '../../services/overrideValidationService.js';
import {
  swapSubscriptionPrice,
  isStripeConfigured,
  listInvoicesForCustomer,
  createCreditNote,
  voidInvoice,
  retryInvoicePayment,
  applyCouponToSubscription,
  removeCouponFromSubscription,
  pauseSubscription,
  resumeSubscription,
  setBillingCycleAnchor,
  inspectCustomerCurrency,
  createOverridePrice
} from '../../services/stripeService.js';
import { sendPlanChangeNotice } from '../../services/billingEmails.js';
import { getOrgOwnerEmail } from '../../utils/getOrgOwnerEmail.js';

const router = express.Router();

router.use(authenticate);
// Default gate is "any Calcite staff can read" — sensitive write endpoints
// add stricter middleware (requireSuperAdmin / requireBillingStaff) per-route.
router.use(requireCalciteStaff);

// ════════════════════════════════════════════════════════════════════
// TENANTS
// ════════════════════════════════════════════════════════════════════

/** GET /admin/tenants — list every registered tenant + their plan + override summary. */
router.get('/tenants', asyncHandler(async (req, res) => {
  const { Tenant, OrganizationSubscription, SubscriptionPlan, SubscriptionOverride } = getRouterModels();
  const tenants = await Tenant.find({}).sort({ createdAt: -1 }).lean();

  const orgIds = tenants.map((t) => t.orgId);
  const subs = await OrganizationSubscription.find({ organization_id: { $in: orgIds } }).lean();
  const overrides = await SubscriptionOverride.find({ tenant_id: { $in: orgIds } }).lean();
  const plans = await SubscriptionPlan.find({}).lean();

  const subByOrg = new Map(subs.map((s) => [s.organization_id, s]));
  const overrideByOrg = new Map(overrides.map((o) => [o.tenant_id, o]));
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  // Look up each tenant's organisation display name from its own DB.
  // Run in parallel, swallow per-tenant errors so a single failing DB
  // doesn't blank the entire list. Returns a map { orgId -> name }.
  const organizationSchema = (await import('../../db/schemas/platform/organizationSchema.js')).default;
  const { getTenantConnection } = await import('../../db/connectionManager.js');
  const nameByOrg = new Map();
  await Promise.all(tenants.map(async (t) => {
    try {
      const tenantDb = await getTenantConnection(String(t.orgId).toLowerCase());
      const Org = tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
      const org = await Org.findOne({}).select('name trading_name').lean();
      const name = org?.name || org?.trading_name || null;
      if (name) nameByOrg.set(t.orgId, name);
    } catch (err) {
      // One failed connection is non-fatal — caller falls back to orgId.
      console.warn('[admin/tenants] name lookup failed for', t.orgId, ':', err?.message || err);
    }
  }));

  const data = tenants.map((t) => {
    const sub = subByOrg.get(t.orgId);
    const plan = sub ? planById.get(String(sub.plan_id)) : null;
    const override = overrideByOrg.get(t.orgId);
    return {
      orgId: t.orgId,
      tenant_name: nameByOrg.get(t.orgId) || null,
      dbName: t.dbName,
      status: t.status,
      created_at: t.createdAt,
      subscription: sub
        ? {
            plan_code: plan?.plan_code || 'unknown',
            plan_name: plan?.plan_name || '—',
            billing_cycle: sub.billing_cycle,
            status: sub.status,
            current_period_end: sub.current_period_end
          }
        : null,
      has_override: !!override
    };
  });
  res.json({ success: true, data });
}));

/** GET /admin/tenants/:orgId — tenant detail (subscription + override + recent events). */
router.get(
  '/tenants/:orgId',
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription, SubscriptionPlan, SubscriptionOverride, BillingEvent } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const tenant = await Tenant.findOne({ orgId }).lean();
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId }).lean();
    const plan = sub ? await SubscriptionPlan.findById(sub.plan_id).lean() : null;
    const override = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
    const recentEvents = await BillingEvent.find({ tenant_id: orgId })
      .sort({ created_at: -1 }).limit(20).lean();

    // Compute the same entitlements the tenant gets so the SuperAdmin can
    // verify exactly what features / limits are actually being granted.
    const effectiveEntitlements = await resolveEntitlements(orgId).catch(() => null);

    // Resolve the Stripe customer's locked currency so the override UI
    // can show the right currency label and the auto-create Price helper
    // mints in the matching currency. Best-effort — failures don't break
    // the page (the UI falls back to the plan's default currency).
    let stripeCustomerCurrency = null;
    if (sub?.stripe_customer_id && isStripeConfigured()) {
      const inspect = await inspectCustomerCurrency(sub.stripe_customer_id).catch(() => null);
      if (inspect?.ok && inspect.currency) {
        stripeCustomerCurrency = inspect.currency.toLowerCase();
      }
    }
    const overrideCurrency =
      stripeCustomerCurrency ||
      (plan?.pricing?.currency || 'AUD').toLowerCase();

    res.json({
      success: true,
      data: {
        orgId: tenant.orgId,
        dbName: tenant.dbName,
        status: tenant.status,
        created_at: tenant.createdAt,
        subscription: sub
          ? {
              _id: sub._id,
              plan_id: sub.plan_id,
              plan_code: plan?.plan_code || null,
              plan_name: plan?.plan_name || null,
              plan_stripe_product_id: plan?.pricing?.stripeProductId || '',
              billing_cycle: sub.billing_cycle,
              status: sub.status,
              current_period_start: sub.current_period_start,
              current_period_end: sub.current_period_end,
              cancel_at_period_end: sub.cancel_at_period_end,
              stripe_customer_id: sub.stripe_customer_id || null,
              stripe_customer_currency: stripeCustomerCurrency,
              stripe_subscription_id: sub.stripe_subscription_id || null,
              is_comp: !!sub.is_comp,
              comp_reason: sub.comp_reason || '',
              comp_granted_at: sub.comp_granted_at || null
            }
          : null,
        override_currency: overrideCurrency,
        override: override
          ? {
              _id: override._id,
              limits: override.limits || {},
              feature_flags: override.feature_flags instanceof Map
                ? Object.fromEntries(override.feature_flags)
                : (override.feature_flags || {}),
              feature_flag_mode: override.feature_flag_mode || 'merge',
              pricing: override.pricing || {},
              effective_from: override.effective_from,
              effective_until: override.effective_until,
              reason: override.reason || ''
            }
          : null,
        recent_events: recentEvents.map(serializeEvent),
        // What the tenant actually sees (post merge of plan + override + kill-switch).
        effective: effectiveEntitlements
      }
    });
  })
);

// ════════════════════════════════════════════════════════════════════
// SUPPORT IMPERSONATION ("Act as support")
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/act-as
 *
 * Mints a short-lived tenant-scoped JWT so a Calcite super-admin or
 * support agent can operate inside any tenant exactly like an org admin
 * (workflows, checklists, members, etc.). The token carries:
 *
 *   - userId:    the agent's SuperAdmin id (preserved for audit)
 *   - orgId:     the target tenant
 *   - roles:     ['admin']    — bypasses runtime per-position recompute
 *   - permissions: ['*:*']    — full admin within the tenant app
 *   - support_session:  true
 *   - support_agent_id, support_agent_email, support_session_id, reason
 *
 * Auth middleware sees `support_session=true` and skips the
 * position-transferred + account-inactive checks (the agent has no
 * tenant user record). Every session start writes a BillingEvent so
 * there's an immutable paper trail of who opened which tenant and why.
 *
 * Token TTL is 1h — short enough to limit damage from a leaked token,
 * long enough to fix a real issue without re-auth churn.
 */
router.post(
  '/tenants/:orgId/act-as',
  requireSupportStaff,
  [
    param('orgId').isString().trim().notEmpty(),
    body('reason').optional().isString().trim().isLength({ max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const tenant = await Tenant.findOne({ orgId }).lean();
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }

    const sessionId = crypto.randomUUID();
    const reason = (req.body?.reason || '').trim();
    const agentId = req.user?.userId || null;
    const agentEmail = req.user?.email || '';

    const payload = {
      userId: agentId,
      orgId,
      email: agentEmail,
      roles: ['admin'],
      permissions: ['*:*'],
      support_session: true,
      support_agent_id: agentId,
      support_agent_email: agentEmail,
      support_session_id: sessionId,
      support_reason: reason || null
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: '1h',
      issuer: 'charity-compliance-api',
      audience: 'charity-compliance-client'
    });

    await writeBillingEvent(req, {
      action: 'support.session_started',
      targetType: 'tenant',
      targetId: orgId,
      targetLabel: tenant.dbName || orgId,
      tenantId: orgId,
      reason,
      metadata: {
        session_id: sessionId,
        agent_id: agentId,
        agent_email: agentEmail,
        ttl_seconds: 3600
      }
    });

    // Mirror the shape the tenant /auth/login endpoint returns so the
    // frontend can drop this user into authStore unchanged.
    const userPayload = {
      userId: agentId,
      id: agentId,
      orgId,
      email: agentEmail,
      first_name: 'Calcite',
      last_name: 'Support',
      fullName: agentEmail || 'Calcite Support',
      roles: ['admin'],
      role: 'admin',
      permissions: ['*:*'],
      is_org_owner: false,
      is_auditor: false,
      support_session: true,
      support_agent_id: agentId,
      support_agent_email: agentEmail,
      support_session_id: sessionId,
      support_reason: reason || null
    };

    res.json({
      success: true,
      data: {
        token,
        orgId,
        user: userPayload,
        expires_in: 3600,
        session_id: sessionId
      }
    });
  })
);

/** POST /admin/support-session/end — write the session-ended audit row. */
router.post(
  '/support-session/end',
  requireSupportStaff,
  [
    body('session_id').optional().isString().trim(),
    body('orgId').optional().isString().trim(),
    body('reason').optional().isString().trim().isLength({ max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    await writeBillingEvent(req, {
      action: 'support.session_ended',
      targetType: 'tenant',
      targetId: String(req.body?.orgId || '').toLowerCase(),
      targetLabel: req.body?.orgId || '',
      tenantId: String(req.body?.orgId || '').toLowerCase(),
      reason: req.body?.reason || '',
      metadata: {
        session_id: req.body?.session_id || null,
        agent_id: req.user?.userId || null,
        agent_email: req.user?.email || ''
      }
    });
    res.json({ success: true });
  })
);

/** POST /admin/tenants/:orgId/assign-plan — set/change the tenant's plan. */
router.post(
  '/tenants/:orgId/assign-plan',
  requireBillingStaff,
  [
    param('orgId').isString().trim().notEmpty(),
    body('plan_code').isString().trim().notEmpty(),
    body('billing_cycle').optional().isIn(['monthly', 'yearly']),
    // Migration mode (handbook §3.1):
    //  - 'at_renewal' (default, safe) — change locally now; Stripe swap
    //    happens at the cycle anchor with no proration.
    //  - 'immediately_prorated' — swap Stripe price now with prorated
    //    refund/charge for the unused/used portion.
    //  - 'no_migrate' — change the future-cycles config locally without
    //    touching Stripe at all.
    body('mode').optional().isIn(['at_renewal', 'immediately_prorated', 'no_migrate'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription, SubscriptionPlan, PlanRevision } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const planCode = String(req.body.plan_code).toLowerCase();
    const billingCycle = req.body.billing_cycle || 'monthly';

    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }
    const plan = await SubscriptionPlan.findOne({ plan_code: planCode });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PLAN_NOT_FOUND',
          message: 'Plan must be saved (not just a template) before it can be assigned to a tenant.'
        }
      });
    }

    // Pin to the *latest* revision of this plan at assignment time.
    const latestRevision = await PlanRevision
      .findOne({ plan_id: plan._id })
      .sort({ revision_number: -1 })
      .lean();

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    const existing = await OrganizationSubscription.findOne({ organization_id: orgId });
    let action = 'subscription.assigned';
    let prev = null;
    if (existing) {
      action = 'subscription.changed';
      prev = {
        plan_id: existing.plan_id,
        plan_revision_number: existing.plan_revision_number,
        billing_cycle: existing.billing_cycle,
        status: existing.status
      };
      existing.plan_id = plan._id;
      existing.plan_revision_id = latestRevision?._id || null;
      existing.plan_revision_number = latestRevision?.revision_number || null;
      existing.billing_cycle = billingCycle;
      existing.status = 'active';
      existing.current_period_start = now;
      existing.current_period_end = periodEnd;
      await existing.save();
    } else {
      await OrganizationSubscription.create({
        organization_id: orgId,
        plan_id: plan._id,
        plan_revision_id: latestRevision?._id || null,
        plan_revision_number: latestRevision?.revision_number || null,
        billing_cycle: billingCycle,
        status: 'active',
        current_period_start: now,
        current_period_end: periodEnd
      });
    }

    // Bust the entitlement cache so the tenant picks up the new plan.
    invalidateEntitlements(orgId);

    // Stripe swap based on migration mode. Existing tenants with a live
    // Stripe subscription get their price item moved to the new plan's
    // price; mode controls the proration behaviour.
    const mode = req.body.mode || 'at_renewal';
    let stripeSwap = null;
    if (existing?.stripe_subscription_id && mode !== 'no_migrate' && isStripeConfigured()) {
      const newPriceId = billingCycle === 'yearly'
        ? plan.pricing?.stripeAnnualPriceId
        : plan.pricing?.stripeMonthlyPriceId;
      if (newPriceId) {
        const proration = mode === 'immediately_prorated' ? 'create_prorations' : 'none';
        const swap = await swapSubscriptionPrice({
          subscriptionId: existing.stripe_subscription_id,
          newPriceId,
          proration
        });
        stripeSwap = { ok: swap.ok, error: swap.error || null, mode, proration };
      } else {
        stripeSwap = { ok: false, error: 'No Stripe price for the chosen cycle on the new plan.' };
      }
    }

    await writeBillingEvent(req, {
      action,
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      diff: prev ? [{ path: 'plan_id', from: String(prev.plan_id), to: String(plan._id) }] : [],
      reason: req.body.reason || `Assigned ${plan.plan_name}.`,
      metadata: {
        plan_code: plan.plan_code,
        billing_cycle: billingCycle,
        revision_number: latestRevision?.revision_number || null,
        migration_mode: mode,
        stripe_swap: stripeSwap
      }
    });

    // Notify org owner about the assignment.
    const ownerEmail = await getOrgOwnerEmail(orgId).catch(() => null);
    if (ownerEmail) {
      sendPlanChangeNotice({
        to: ownerEmail,
        orgName: orgId,
        planName: plan.plan_name,
        billingCycle,
        amountAUD: billingCycle === 'yearly' ? plan.pricing?.annualAUD : plan.pricing?.monthlyAUD,
        reason: req.body.reason || null
      });
    }

    res.json({ success: true });
  })
);

// ════════════════════════════════════════════════════════════════════
// PLAN REVISION MIGRATION (Phase 9 — done early so SuperAdmin has
// a clean way to push a price update to all tenants on a plan).
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/comp — flag this tenant's subscription as
 * comped (free access, no payment required). Reason is mandatory and
 * recorded in BillingEvent.
 *
 * Body: { is_comp: boolean, reason?: string }
 */
router.post(
  '/tenants/:orgId/comp',
  requireSuperAdmin,
  [
    param('orgId').isString().trim().notEmpty(),
    body('is_comp').isBoolean(),
    // Required: this grants/revokes free access — audit needs the reason.
    body('reason').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Reason is required when toggling comp status.')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const isComp = !!req.body.is_comp;
    const reason = String(req.body.reason || '').trim();

    if (isComp && !reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'A reason is required to grant comp access.' }
      });
    }

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub) {
      return res.status(404).json({
        success: false,
        error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Tenant has no subscription to comp. Assign a plan first.' }
      });
    }

    const wasComp = !!sub.is_comp;
    sub.is_comp = isComp;
    sub.comp_reason = isComp ? reason : '';
    sub.comp_granted_by = isComp ? (req.user?.userId || null) : null;
    sub.comp_granted_at = isComp ? new Date() : null;
    if (isComp && sub.status !== 'active') sub.status = 'active';
    await sub.save();

    invalidateEntitlements(orgId);

    await writeBillingEvent(req, {
      action: isComp ? 'subscription_override.created' : 'subscription_override.cleared',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: isComp ? `Comped — ${reason}` : 'Comp removed.',
      diff: [{ path: 'is_comp', from: wasComp, to: isComp }],
      metadata: { kind: 'comp_grant' }
    });

    res.json({ success: true, data: { is_comp: sub.is_comp } });
  })
);

router.post(
  '/plans/:code/migrate-revision',
  requireSuperAdmin,
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision, OrganizationSubscription } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const reason = String(req.body.reason || 'Plan revision migration.').trim();

    const plan = await SubscriptionPlan.findOne({ plan_code: code });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'No such plan.' }
      });
    }
    const latest = await PlanRevision.findOne({ plan_id: plan._id }).sort({ revision_number: -1 }).lean();
    if (!latest) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_REVISIONS', message: 'Plan has no revisions yet.' }
      });
    }

    const stale = await OrganizationSubscription.find({
      plan_id: plan._id,
      $or: [
        { plan_revision_number: { $lt: latest.revision_number } },
        { plan_revision_id: null }
      ]
    });

    // Pick the Stripe Price for the new revision based on each tenant's
    // billing cycle. Snapshot may include the IDs; otherwise read the live plan.
    const monthlyPriceId = latest.snapshot?.pricing?.stripeMonthlyPriceId
      || plan.pricing?.stripeMonthlyPriceId || null;
    const annualPriceId = latest.snapshot?.pricing?.stripeAnnualPriceId
      || plan.pricing?.stripeAnnualPriceId || null;

    let migrated = 0;
    let stripeSynced = 0;
    let stripeFailed = 0;
    const stripeErrors = [];

    for (const sub of stale) {
      const fromRev = sub.plan_revision_number;
      sub.plan_revision_id = latest._id;
      sub.plan_revision_number = latest.revision_number;
      await sub.save();
      invalidateEntitlements(sub.organization_id);

      // Sync to Stripe if the tenant has a real subscription there.
      let stripeStatus = 'skipped'; // 'skipped' | 'synced' | 'failed'
      let stripeError = null;
      if (isStripeConfigured() && sub.stripe_subscription_id) {
        const newPriceId = sub.billing_cycle === 'yearly' ? annualPriceId : monthlyPriceId;
        if (newPriceId) {
          const result = await swapSubscriptionPrice({
            subscriptionId: sub.stripe_subscription_id,
            newPriceId
          });
          if (result.ok) {
            stripeStatus = 'synced';
            stripeSynced += 1;
          } else {
            stripeStatus = 'failed';
            stripeFailed += 1;
            stripeError = result.error;
            stripeErrors.push({ orgId: sub.organization_id, error: result.error });
          }
        } else {
          stripeStatus = 'skipped';
          stripeErrors.push({ orgId: sub.organization_id, error: 'No Stripe price for cycle on the latest revision' });
        }
      }

      await writeBillingEvent(req, {
        action: 'subscription.revision_migrated',
        targetType: 'subscription',
        targetId: sub.organization_id,
        targetLabel: sub.organization_id,
        tenantId: sub.organization_id,
        diff: [{ path: 'plan_revision_number', from: fromRev, to: latest.revision_number }],
        reason,
        metadata: {
          plan_code: plan.plan_code,
          to_revision: latest.revision_number,
          stripe_sync: stripeStatus,
          ...(stripeError ? { stripe_error: stripeError } : {})
        }
      });

      // Notify the org owner about the new pricing/plan version.
      const ownerEmail = await getOrgOwnerEmail(sub.organization_id).catch(() => null);
      if (ownerEmail) {
        const newPricing = latest.snapshot?.pricing || plan.pricing || {};
        sendPlanChangeNotice({
          to: ownerEmail,
          orgName: sub.organization_id,
          planName: plan.plan_name,
          billingCycle: sub.billing_cycle,
          amountAUD: sub.billing_cycle === 'yearly' ? newPricing.annualAUD : newPricing.monthlyAUD,
          reason
        });
      }

      migrated += 1;
    }

    res.json({
      success: true,
      data: {
        migrated,
        latest_revision: latest.revision_number,
        stripe_synced: stripeSynced,
        stripe_failed: stripeFailed,
        stripe_errors: stripeErrors
      }
    });
  })
);

/** PUT /admin/tenants/:orgId/override — create or replace per-tenant override. */
router.put(
  '/tenants/:orgId/override',
  requireSuperAdmin,
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
      });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'REASON_REQUIRED', message: 'A reason is required for any override.' }
      });
    }

    // Validate against live tenant usage — refuse caps below current usage.
    const validation = await validateOverride(orgId, req.body);
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'OVERRIDE_BELOW_USAGE',
          message: 'One or more limits are below current tenant usage.',
          details: { conflicts: validation.conflicts }
        }
      });
    }

    // ── Stripe Price auto-creation ──────────────────────────────────
    //
    // If the admin entered numeric monthly/annual amounts but didn't
    // paste corresponding Stripe price IDs, mint them here against the
    // plan's existing Stripe product. This is the "layman default" path
    // — they only ever see the amount; the dashboard step is automatic.
    //
    // The advanced-disclosure path is the existing manual-paste fields;
    // any price ID supplied directly is used verbatim.
    //
    // Currency follows the tenant's Stripe customer lock if there is
    // one (otherwise the plan's default currency, otherwise AUD). This
    // matches the "customer.currency is sticky" Stripe rule.
    const incomingPricing = { ...(req.body.pricing || {}) };
    const pricingWarnings = [];
    // Hoist the subscription lookup so the auto-apply step further down
    // can swap the override Price onto the live Stripe subscription
    // without reloading.
    const { SubscriptionPlan: SP, OrganizationSubscription: OS } = getRouterModels();
    const sub = await OS.findOne({ organization_id: orgId }).lean();
    if (isStripeConfigured()) {
      // OrganizationSubscription stores `plan_id` (ObjectId), not a
      // plan_code string — look the plan up by id, then read its code.
      const plan = sub?.plan_id ? await SP.findById(sub.plan_id).lean() : null;
      const planCode = plan?.plan_code || '';
      const productId = plan?.pricing?.stripeProductId || '';

      // Determine the currency to mint the Price in.
      let targetCurrency = (plan?.pricing?.currency || 'AUD').toLowerCase();
      if (sub?.stripe_customer_id) {
        const inspect = await inspectCustomerCurrency(sub.stripe_customer_id);
        if (inspect.ok && inspect.currency) targetCurrency = inspect.currency.toLowerCase();
      }

      const monthlyAmount = Number(incomingPricing.monthlyAUD);
      const annualAmount  = Number(incomingPricing.annualAUD);
      const wantsMonthly  = Number.isFinite(monthlyAmount) && monthlyAmount > 0;
      const wantsAnnual   = Number.isFinite(annualAmount)  && annualAmount  > 0;
      const monthlyIdSupplied = !!incomingPricing.stripeMonthlyPriceId;
      const annualIdSupplied  = !!incomingPricing.stripeAnnualPriceId;

      if ((wantsMonthly && !monthlyIdSupplied) || (wantsAnnual && !annualIdSupplied)) {
        if (!productId) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'PLAN_NOT_SYNCED_TO_STRIPE',
              message: 'The tenant\'s plan has not been synced to Stripe yet — open the plan and click "Sync to Stripe" before creating an override price.'
            }
          });
        }
        if (wantsMonthly && !monthlyIdSupplied) {
          const result = await createOverridePrice({
            productId,
            amount: monthlyAmount,
            currency: targetCurrency,
            interval: 'month',
            orgId,
            planCode: planCode || '',
            reason
          });
          if (!result.ok) {
            return res.status(502).json({
              success: false,
              error: { code: 'STRIPE_PRICE_CREATE_FAILED', message: result.error || 'Could not create the monthly Stripe price.' }
            });
          }
          incomingPricing.stripeMonthlyPriceId = result.price.id;
          incomingPricing.currency = targetCurrency.toUpperCase();
          pricingWarnings.push({ cycle: 'monthly', stripe_price_id: result.price.id, currency: targetCurrency });
        }
        if (wantsAnnual && !annualIdSupplied) {
          const result = await createOverridePrice({
            productId,
            amount: annualAmount,
            currency: targetCurrency,
            interval: 'year',
            orgId,
            planCode: planCode || '',
            reason
          });
          if (!result.ok) {
            return res.status(502).json({
              success: false,
              error: { code: 'STRIPE_PRICE_CREATE_FAILED', message: result.error || 'Could not create the annual Stripe price.' }
            });
          }
          incomingPricing.stripeAnnualPriceId = result.price.id;
          incomingPricing.currency = targetCurrency.toUpperCase();
          pricingWarnings.push({ cycle: 'annual', stripe_price_id: result.price.id, currency: targetCurrency });
        }
      }
    }

    const update = {
      tenant_id: orgId,
      limits: req.body.limits || {},
      feature_flags: req.body.feature_flags || {},
      feature_flag_mode: req.body.feature_flag_mode === 'replace' ? 'replace' : 'merge',
      pricing: incomingPricing,
      effective_from: req.body.effective_from ? new Date(req.body.effective_from) : new Date(),
      effective_until: req.body.effective_until ? new Date(req.body.effective_until) : null,
      reason,
      approved_by: req.user?.userId || null,
      approved_at: new Date()
    };

    const before = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
    const result = await SubscriptionOverride.findOneAndUpdate(
      { tenant_id: orgId },
      { $set: update },
      { upsert: true, new: true }
    );

    invalidateEntitlements(orgId);

    // ── Auto-apply override Price to the live Stripe subscription ───
    //
    // Saving the override creates the Price in Stripe, but until we
    // swap it onto the actual subscription, invoices keep billing at
    // the plan default. From the admin's mental model, "I lowered the
    // price" should mean "the next invoice is lower" — make it so.
    //
    // We only auto-apply if the tenant has a live Stripe subscription
    // AND the override has a price ID for the tenant's current cycle.
    // Failures are surfaced as a warning, not a hard error — the DB
    // override is already saved, so the entitlement/feature side is
    // correct; only the billing-side swap missed and can be retried
    // via the explicit "Apply to Stripe" button.
    let autoAppliedToSubscription = null;
    let autoApplyError = null;
    if (isStripeConfigured() && sub?.stripe_subscription_id) {
      const newPriceId = sub.billing_cycle === 'yearly'
        ? incomingPricing.stripeAnnualPriceId
        : incomingPricing.stripeMonthlyPriceId;
      if (newPriceId) {
        const swap = await swapSubscriptionPrice({
          subscriptionId: sub.stripe_subscription_id,
          newPriceId
        });
        if (swap.ok) {
          autoAppliedToSubscription = {
            stripe_subscription_id: sub.stripe_subscription_id,
            stripe_price_id: newPriceId,
            cycle: sub.billing_cycle
          };
        } else {
          autoApplyError = swap.error || 'Unknown Stripe error.';
        }
      }
    }

    await writeBillingEvent(req, {
      action: before ? 'subscription_override.updated' : 'subscription_override.created',
      targetType: 'subscription_override',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason,
      diff: before
        ? [{ path: 'override', from: { limits: before.limits, pricing: before.pricing }, to: { limits: update.limits, pricing: update.pricing } }]
        : [],
      metadata: {
        effective_until: update.effective_until,
        ...(pricingWarnings.length ? { auto_created_stripe_prices: pricingWarnings } : {}),
        ...(autoAppliedToSubscription ? { auto_applied_to_subscription: autoAppliedToSubscription } : {}),
        ...(autoApplyError ? { auto_apply_error: autoApplyError } : {})
      }
    });

    res.json({
      success: true,
      data: {
        _id: result._id,
        pricing: result.pricing || {},
        auto_created_stripe_prices: pricingWarnings,
        auto_applied_to_subscription: autoAppliedToSubscription,
        auto_apply_error: autoApplyError
      }
    });
  })
);

/**
 * POST /admin/tenants/:orgId/override/apply-to-stripe
 *
 * Push the override's tenant-specific Stripe Price IDs onto the tenant's
 * actual Stripe subscription so future invoices bill the override amount,
 * not the plan default. No-op if no override / no Stripe sub / no price IDs.
 */
router.post(
  '/tenants/:orgId/override/apply-to-stripe',
  requireBillingStaff,
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { OrganizationSubscription, SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' }
      });
    }

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(409).json({
        success: false,
        error: { code: 'NO_STRIPE_SUBSCRIPTION', message: 'Tenant has no Stripe subscription to update.' }
      });
    }
    const override = await SubscriptionOverride.findOne({ tenant_id: orgId });
    if (!override) {
      return res.status(404).json({
        success: false,
        error: { code: 'OVERRIDE_NOT_FOUND', message: 'No override saved for this tenant.' }
      });
    }
    const newPriceId = sub.billing_cycle === 'yearly'
      ? override.pricing?.stripeAnnualPriceId
      : override.pricing?.stripeMonthlyPriceId;
    if (!newPriceId) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'OVERRIDE_PRICE_MISSING',
          message: `Override has no Stripe ${sub.billing_cycle === 'yearly' ? 'annual' : 'monthly'} price configured.`
        }
      });
    }

    const result = await swapSubscriptionPrice({
      subscriptionId: sub.stripe_subscription_id,
      newPriceId
    });
    if (!result.ok) {
      return res.status(502).json({
        success: false,
        error: { code: 'STRIPE_UPDATE_FAILED', message: result.error }
      });
    }

    await writeBillingEvent(req, {
      action: 'subscription_override.updated',
      targetType: 'subscription_override',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: 'Override pricing applied to Stripe subscription.',
      metadata: { stripe_price_id: newPriceId, stripe_subscription_id: sub.stripe_subscription_id }
    });

    res.json({ success: true, data: { stripe_price_id: newPriceId } });
  })
);

/** DELETE /admin/tenants/:orgId/override — clear the tenant's override. */
router.delete(
  '/tenants/:orgId/override',
  requireSuperAdmin,
  [param('orgId').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionOverride } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const result = await SubscriptionOverride.findOneAndDelete({ tenant_id: orgId });
    if (result) {
      invalidateEntitlements(orgId);
      await writeBillingEvent(req, {
        action: 'subscription_override.cleared',
        targetType: 'subscription_override',
        targetId: orgId,
        targetLabel: orgId,
        tenantId: orgId,
        reason: 'Override cleared.'
      });
    }
    res.json({ success: true });
  })
);

// ════════════════════════════════════════════════════════════════════
// COUPONS
// ════════════════════════════════════════════════════════════════════

router.get('/coupons', asyncHandler(async (req, res) => {
  const { Coupon } = getRouterModels();
  const coupons = await Coupon.find({}).sort({ created_at: -1 }).lean();
  res.json({ success: true, data: coupons.map(serializeCoupon) });
}));

router.post(
  '/coupons',
  requireBillingStaff,
  [
    body('code').isString().trim().isLength({ min: 2, max: 64 }).matches(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    body('percent_off').optional().isFloat({ min: 0, max: 100 }),
    body('amount_off_aud').optional().isFloat({ min: 0 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Coupon } = getRouterModels();
    const code = String(req.body.code).toUpperCase().trim();
    if (!req.body.percent_off && !req.body.amount_off_aud) {
      return res.status(400).json({
        success: false,
        error: { code: 'DISCOUNT_REQUIRED', message: 'One of percent_off or amount_off_aud is required.' }
      });
    }
    const exists = await Coupon.findOne({ code });
    if (exists) {
      return res.status(409).json({
        success: false,
        error: { code: 'COUPON_CODE_TAKEN', message: 'A coupon with that code already exists.' }
      });
    }
    const created = await Coupon.create({
      code,
      name: req.body.name || '',
      percent_off: req.body.percent_off ?? null,
      amount_off_aud: req.body.amount_off_aud ?? null,
      duration: req.body.duration || 'once',
      duration_in_months: req.body.duration_in_months ?? null,
      max_redemptions: req.body.max_redemptions ?? null,
      redeem_by: req.body.redeem_by ? new Date(req.body.redeem_by) : null,
      applies_to_plan_codes: Array.isArray(req.body.applies_to_plan_codes) ? req.body.applies_to_plan_codes : [],
      created_by: req.user?.userId || null
    });
    await writeBillingEvent(req, {
      action: 'coupon.created',
      targetType: 'coupon',
      targetId: created.code,
      targetLabel: created.name || created.code
    });
    res.status(201).json({ success: true, data: serializeCoupon(created.toObject()) });
  })
);

router.post(
  '/coupons/:code/archive',
  requireBillingStaff,
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { Coupon } = getRouterModels();
    const code = String(req.params.code).toUpperCase();
    const coupon = await Coupon.findOne({ code });
    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: { code: 'COUPON_NOT_FOUND', message: 'No such coupon.' }
      });
    }
    coupon.status = 'archived';
    await coupon.save();
    await writeBillingEvent(req, {
      action: 'coupon.archived',
      targetType: 'coupon',
      targetId: coupon.code,
      targetLabel: coupon.name || coupon.code
    });
    res.json({ success: true, data: serializeCoupon(coupon.toObject()) });
  })
);

// ════════════════════════════════════════════════════════════════════
// INVOICES (Payment records — populated by Stripe invoice.paid webhook)
// ════════════════════════════════════════════════════════════════════

router.get(
  '/invoices',
  [
    query('tenantId').optional().isString().trim(),
    query('status').optional().isIn(['succeeded', 'failed', 'pending', 'refunded']),
    query('limit').optional().isInt({ min: 1, max: 200 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Payment } = getRouterModels();
    const limit = parseInt(req.query.limit || '100', 10);
    const filter = {};
    if (req.query.tenantId) filter.organization_id = String(req.query.tenantId).toLowerCase();
    if (req.query.status) filter.status = String(req.query.status);
    const payments = await Payment
      .find(filter)
      .sort({ payment_date: -1 })
      .limit(limit)
      .lean();
    res.json({
      success: true,
      data: payments.map((p) => ({
        _id: p._id,
        organization_id: p.organization_id,
        amount: p.amount,
        currency: p.currency || 'AUD',
        status: p.status,
        description: p.description || '',
        invoice_number: p.metadata?.invoice_number || null,
        hosted_invoice_url: p.metadata?.hosted_invoice_url || null,
        invoice_pdf: p.metadata?.invoice_pdf || null,
        stripe_invoice_id: p.stripe_invoice_id || null,
        stripe_payment_intent_id: p.stripe_payment_intent_id || null,
        stripe_subscription_id: p.metadata?.stripe_subscription_id || null,
        payment_date: p.payment_date,
        failure_reason: p.failure_reason || null
      }))
    });
  })
);

/**
 * POST /admin/invoices/backfill
 *
 * Reconcile missing Payment records by pulling every Stripe customer's
 * invoice history and upserting any we haven't already stored. Idempotent
 * via the unique index on `stripe_invoice_id`.
 *
 * Body (optional):
 *   - tenantId — restrict backfill to one tenant
 *   - limit    — max invoices per customer (default 100)
 */
router.post(
  '/invoices/backfill',
  requireBillingStaff,
  [
    body('tenantId').optional().isString().trim(),
    body('limit').optional().isInt({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' }
      });
    }

    const { OrganizationSubscription, Payment } = getRouterModels();
    const tenantFilter = req.body.tenantId ? { organization_id: String(req.body.tenantId).toLowerCase() } : {};
    const limit = parseInt(req.body.limit || '100', 10);

    // Find tenants with a Stripe customer to backfill against.
    const subs = await OrganizationSubscription
      .find({ ...tenantFilter, stripe_customer_id: { $exists: true, $ne: null, $nin: ['', null] } })
      .lean();

    if (subs.length === 0) {
      return res.json({
        success: true,
        data: { tenants_scanned: 0, inserted: 0, already_present: 0, errors: [] }
      });
    }

    let inserted = 0;
    let alreadyPresent = 0;
    const errors = [];

    for (const sub of subs) {
      try {
        const invoices = await listInvoicesForCustomer({ customerId: sub.stripe_customer_id, limit });
        for (const inv of invoices) {
          // Skip drafts and uncollected invoices — only persist things that
          // represent actual money state changes.
          if (!['paid', 'uncollectible', 'void', 'open'].includes(inv.status)) continue;

          // Map Stripe invoice status → local Payment status.
          let localStatus = 'pending';
          if (inv.status === 'paid')          localStatus = 'succeeded';
          else if (inv.status === 'uncollectible') localStatus = 'failed';
          else if (inv.status === 'void')     localStatus = 'failed';

          try {
            const created = await Payment.create({
              organization_id: sub.organization_id,
              stripe_payment_id: inv.payment_intent || inv.id,
              stripe_payment_intent_id: inv.payment_intent || null,
              stripe_invoice_id: inv.id,
              amount: (inv.amount_paid || inv.amount_due || 0) / 100,
              currency: (inv.currency || 'aud').toUpperCase(),
              status: localStatus,
              description: inv.description || `Stripe invoice ${inv.number || inv.id}`,
              metadata: {
                hosted_invoice_url: inv.hosted_invoice_url,
                invoice_pdf: inv.invoice_pdf,
                invoice_number: inv.number,
                stripe_subscription_id: inv.subscription,
                backfilled: true
              },
              payment_date: inv.status_transitions?.paid_at
                ? new Date(inv.status_transitions.paid_at * 1000)
                : new Date(inv.created * 1000)
            });
            if (created) inserted += 1;
          } catch (err) {
            if (err?.code === 11000) {
              alreadyPresent += 1; // unique index hit — already stored
            } else {
              errors.push({ orgId: sub.organization_id, invoiceId: inv.id, error: err?.message || String(err) });
            }
          }
        }
      } catch (err) {
        errors.push({ orgId: sub.organization_id, error: err?.message || String(err) });
      }
    }

    await writeBillingEvent(req, {
      action: 'plan.updated', // generic catch-all; invoice backfill doesn't have a dedicated action
      targetType: 'invoices',
      targetId: 'backfill',
      targetLabel: req.body.tenantId || 'all-tenants',
      reason: `Invoice backfill: ${inserted} inserted, ${alreadyPresent} already present, ${errors.length} errors.`,
      metadata: { kind: 'invoice_backfill', inserted, already_present: alreadyPresent, errors_count: errors.length }
    });

    res.json({
      success: true,
      data: {
        tenants_scanned: subs.length,
        inserted,
        already_present: alreadyPresent,
        errors
      }
    });
  })
);

// ════════════════════════════════════════════════════════════════════
// INVOICE ACTIONS — credit / void / retry (handbook §3.2 + §5.2 + §5.10)
// ════════════════════════════════════════════════════════════════════

/**
 * Look up a Payment row + its Stripe invoice id from either:
 *   - Payment._id (Mongo)             — what InvoicesPage rows use
 *   - Payment.stripe_invoice_id (str) — the in_… id directly
 *
 * Returns null if nothing matches.
 */
async function loadInvoiceRow(idOrStripeId) {
  const { Payment } = getRouterModels();
  const id = String(idOrStripeId || '');
  if (!id) return null;
  if (/^in_/.test(id) || /^pi_/.test(id)) {
    return await Payment.findOne({ stripe_invoice_id: id }).lean();
  }
  if (/^[0-9a-fA-F]{24}$/.test(id)) {
    return await Payment.findById(id).lean();
  }
  return null;
}

/**
 * POST /admin/invoices/:id/credit
 * Issue a Stripe credit note. `:id` is either the Payment._id or the
 * Stripe `in_…` invoice id. Reason is required (audited).
 *
 * Body:
 *   - amountAUD?  (optional — defaults to crediting the full invoice)
 *   - reason       string, written to BillingEvent and stripe memo
 *   - stripeReason 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory'
 */
router.post(
  '/invoices/:id/credit',
  requireBillingStaff,
  [
    param('id').isString().trim().notEmpty(),
    body('amountAUD').optional().isFloat({ min: 0.01 }),
    body('reason').isString().trim().isLength({ min: 1, max: 500 }),
    body('stripeReason').optional().isIn(['duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory']),
    body('disposition').optional().isIn(['refund', 'credit_balance', 'out_of_band'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const payment = await loadInvoiceRow(req.params.id);
    if (!payment || !payment.stripe_invoice_id) {
      return res.status(404).json({ success: false, error: { code: 'INVOICE_NOT_FOUND', message: 'No matching invoice.' } });
    }

    const disposition = req.body.disposition || 'credit_balance';
    const { ok, creditNote, error, disposition: actualDisposition } = await createCreditNote({
      invoiceId: payment.stripe_invoice_id,
      amountAUD: req.body.amountAUD,
      memo: req.body.reason,
      reason: req.body.stripeReason || 'order_change',
      disposition
    });
    if (!ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: error || 'Stripe rejected the request.' } });
    }

    await writeBillingEvent(req, {
      action: 'invoice.credit_issued',
      targetType: 'invoice',
      targetId: payment.stripe_invoice_id,
      targetLabel: payment.metadata?.invoice_number || payment.stripe_invoice_id,
      tenantId: payment.organization_id,
      reason: req.body.reason,
      metadata: {
        amount_aud: req.body.amountAUD ?? null,
        stripe_credit_note_id: creditNote?.id,
        stripe_reason: req.body.stripeReason || 'order_change',
        disposition: actualDisposition
      }
    });

    res.json({ success: true, data: { credit_note_id: creditNote?.id, amount_aud: (creditNote?.amount || 0) / 100 } });
  })
);

/**
 * POST /admin/invoices/:id/void
 * Void a finalised-but-unpaid invoice. For paid invoices, /credit instead.
 */
router.post(
  '/invoices/:id/void',
  requireBillingStaff,
  [
    param('id').isString().trim().notEmpty(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const payment = await loadInvoiceRow(req.params.id);
    if (!payment || !payment.stripe_invoice_id) {
      return res.status(404).json({ success: false, error: { code: 'INVOICE_NOT_FOUND', message: 'No matching invoice.' } });
    }
    const { ok, invoice, error } = await voidInvoice(payment.stripe_invoice_id);
    if (!ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: error } });
    }
    await writeBillingEvent(req, {
      action: 'invoice.voided',
      targetType: 'invoice',
      targetId: payment.stripe_invoice_id,
      targetLabel: payment.metadata?.invoice_number || payment.stripe_invoice_id,
      tenantId: payment.organization_id,
      reason: req.body.reason,
      metadata: { stripe_status: invoice?.status }
    });
    res.json({ success: true, data: { invoice_id: invoice?.id, status: invoice?.status } });
  })
);

/**
 * POST /admin/invoices/:id/retry
 * Retry a past_due invoice's payment using the customer's default method.
 */
router.post(
  '/invoices/:id/retry',
  requireBillingStaff,
  [param('id').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const payment = await loadInvoiceRow(req.params.id);
    if (!payment || !payment.stripe_invoice_id) {
      return res.status(404).json({ success: false, error: { code: 'INVOICE_NOT_FOUND', message: 'No matching invoice.' } });
    }
    const { ok, invoice, error } = await retryInvoicePayment(payment.stripe_invoice_id);
    if (!ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: error } });
    }
    await writeBillingEvent(req, {
      action: 'invoice.payment_retried',
      targetType: 'invoice',
      targetId: payment.stripe_invoice_id,
      targetLabel: payment.metadata?.invoice_number || payment.stripe_invoice_id,
      tenantId: payment.organization_id,
      metadata: { stripe_status: invoice?.status, paid: invoice?.paid === true }
    });
    res.json({ success: true, data: { invoice_id: invoice?.id, status: invoice?.status, paid: invoice?.paid === true } });
  })
);

/**
 * POST /admin/invoices/bulk-retry-past-due
 * Iterate every Payment with status='failed' (Stripe past_due) and call
 * retryInvoicePayment on each. Returns per-row results so the operator
 * sees what worked and what didn't.
 */
router.post(
  '/invoices/bulk-retry-past-due',
  requireBillingStaff,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const { Payment } = getRouterModels();
    const failing = await Payment.find({ status: 'failed', stripe_invoice_id: { $ne: null } })
      .sort({ payment_date: 1 })
      .limit(200)
      .lean();
    const results = [];
    for (const p of failing) {
      const { ok, invoice, error } = await retryInvoicePayment(p.stripe_invoice_id);
      results.push({
        invoice_id: p.stripe_invoice_id,
        organization_id: p.organization_id,
        ok,
        paid: invoice?.paid === true,
        error: error || null
      });
    }
    await writeBillingEvent(req, {
      action: 'invoice.bulk_retry_run',
      targetType: 'invoice',
      targetId: 'bulk',
      reason: `Bulk retry across ${failing.length} past_due invoices`,
      metadata: {
        attempted: results.length,
        succeeded: results.filter((r) => r.ok && r.paid).length,
        failed: results.filter((r) => !r.ok || !r.paid).length
      }
    });
    res.json({ success: true, data: { attempted: results.length, results } });
  })
);

// ════════════════════════════════════════════════════════════════════
// COUPON ATTACH / REMOVE on a subscription (handbook §3.2 + §5.3)
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/coupon
 * Attach a Stripe coupon to a tenant's active subscription.
 *
 * Body: { coupon_code, reason }
 */
router.post(
  '/tenants/:orgId/coupon',
  requireBillingStaff,
  [
    param('orgId').isString().trim().notEmpty(),
    body('coupon_code').isString().trim().notEmpty(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const { OrganizationSubscription, Coupon } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub || !sub.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No Stripe subscription linked to this tenant.' } });
    }

    const couponCode = String(req.body.coupon_code).trim();
    const coupon = await Coupon.findOne({ code: couponCode });
    if (!coupon || coupon.archived) {
      return res.status(404).json({ success: false, error: { code: 'COUPON_NOT_FOUND', message: 'Coupon does not exist or is archived.' } });
    }

    // Match the Stripe coupon's currency to the subscription's currency.
    // Otherwise Stripe refuses with "You cannot combine currencies on a
    // single customer." For percent-off coupons the currency suffix is
    // ignored and a single Stripe coupon serves every currency.
    const subCurrency = await currencyForStripeSubscription(sub.stripe_subscription_id);
    const { ensureStripeCouponForLocal } = await import('../../services/stripeService.js');
    const sync = await ensureStripeCouponForLocal(coupon, { currency: subCurrency });
    if (!sync.ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_COUPON_SYNC_FAILED', message: sync.error || 'Could not sync coupon to Stripe.' } });
    }
    if (!coupon.stripe_coupon_id || coupon.stripe_coupon_id !== sync.stripe_coupon_id) {
      coupon.stripe_coupon_id = sync.stripe_coupon_id;
      await coupon.save().catch(() => {});
    }

    const { ok, error } = await applyCouponToSubscription({
      subscriptionId: sub.stripe_subscription_id,
      couponCode: sync.stripe_coupon_id
    });
    if (!ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: error } });
    }

    await writeBillingEvent(req, {
      action: 'coupon.applied',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body.reason,
      metadata: { coupon_code: couponCode, stripe_subscription_id: sub.stripe_subscription_id }
    });

    invalidateEntitlements(orgId);
    res.json({ success: true, data: { coupon_code: couponCode, applied: true } });
  })
);

/**
 * DELETE /admin/tenants/:orgId/coupon
 * Remove the currently-attached coupon from a tenant's subscription.
 */
router.delete(
  '/tenants/:orgId/coupon',
  requireBillingStaff,
  [
    param('orgId').isString().trim().notEmpty(),
    // Required: removing a coupon affects what the customer pays next cycle.
    body('reason').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Reason is required when removing a coupon.')
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const { OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub || !sub.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No Stripe subscription linked to this tenant.' } });
    }
    const { ok, error } = await removeCouponFromSubscription({ subscriptionId: sub.stripe_subscription_id });
    if (!ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: error } });
    }
    await writeBillingEvent(req, {
      action: 'coupon.removed',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body?.reason || '',
      metadata: { stripe_subscription_id: sub.stripe_subscription_id }
    });
    invalidateEntitlements(orgId);
    res.json({ success: true, data: { removed: true } });
  })
);

// ════════════════════════════════════════════════════════════════════
// PROMO PROGRAM FLOWS (handbook §3.1, arch §11)
// ════════════════════════════════════════════════════════════════════

/**
 * Helper: ensure a Coupon doc exists in our local catalogue with the
 * given shape, creating it if absent. Returns the doc.
 */
async function ensureLocalCoupon(code, shape) {
  const { Coupon } = getRouterModels();
  let c = await Coupon.findOne({ code });
  if (!c) c = await Coupon.create({ code, ...shape });
  return c;
}

/**
 * Helper: figure out the currency to use when minting a Stripe coupon
 * for a given Stripe subscription. Stripe rejects amount-off coupons
 * whose currency doesn't match the subscription's price currency
 * ("You cannot combine currencies on a single customer"). We retrieve
 * the subscription and take its `currency` field; falls back to 'aud'
 * when the lookup fails or no sub exists.
 */
async function currencyForStripeSubscription(stripeSubscriptionId) {
  if (!stripeSubscriptionId || !isStripeConfigured()) return 'aud';
  try {
    const { retrieveSubscription } = await import('../../services/stripeService.js');
    const sub = await retrieveSubscription(stripeSubscriptionId);
    return (sub?.currency || 'aud').toLowerCase();
  } catch (_) {
    return 'aud';
  }
}

/**
 * POST /admin/tenants/:orgId/promo/community-impact
 * Body: { abn?, reason }
 * Verifies ABN (best-effort), creates COMMUNITY60 coupon if absent,
 * attaches it to the tenant's subscription, applies a Foundation-tier
 * override that auto-expires after 12 cycles.
 */
router.post(
  '/tenants/:orgId/promo/community-impact',
  requireSuperAdmin,
  [
    param('orgId').isString().trim().notEmpty(),
    body('abn').optional().isString().trim(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { OrganizationSubscription, SubscriptionOverride, SubscriptionPlan } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    // 0. ABN verification (handbook §17.3 — Calcite-approved-only flow).
    // Reject if ABN is missing OR if ABR lookup says the entity isn't
    // a registered charity. Lookup failures (network / API down) fall
    // through with a `verified=false` flag so the audit trail records it.
    let abnVerification = { verified: false, reason: 'no_abn_provided' };
    if (req.body.abn) {
      try {
        const { verifyABN } = await import('../../services/abnVerificationService.js');
        const abrData = await verifyABN(req.body.abn);
        const isCharity = !!(abrData?.is_charity || /charit/i.test(abrData?.entity_type_text || ''));
        abnVerification = {
          verified: !!abrData?.abn_status_text?.toLowerCase().includes('active'),
          is_charity: isCharity,
          entity_name: abrData?.entity_name || null,
          abn_status: abrData?.abn_status_text || null,
          looked_up_at: new Date()
        };
        // Refuse to grant if ABN is inactive or not a charity (per
        // handbook — Community Impact is for registered charities only).
        if (!abnVerification.verified || !isCharity) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'ABN_INELIGIBLE',
              message: 'ABN is not an active registered charity. Community Impact is restricted to ACNC-registered charities.',
              details: abnVerification
            }
          });
        }
      } catch (err) {
        // ABR API down — record but proceed (super-admin override).
        abnVerification = { verified: false, reason: 'abr_lookup_failed', error: err?.message || String(err) };
      }
    }

    // 1. Ensure COMMUNITY60 coupon exists.
    const coupon = await ensureLocalCoupon('COMMUNITY60', {
      name: 'Community Impact — 60% off for 12 months',
      percent_off: 60,
      duration: 'repeating',
      duration_in_months: 12,
      applies_to_plan_codes: [],
      status: 'active'
    });

    // 2. Build a Foundation-tier override with the same feature set.
    const foundation = await SubscriptionPlan.findOne({ plan_code: 'foundation' }).lean();
    const foundationFlags = foundation?.feature_flags
      ? (foundation.feature_flags instanceof Map
          ? Object.fromEntries(foundation.feature_flags)
          : foundation.feature_flags)
      : {};
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 12);
    await SubscriptionOverride.findOneAndUpdate(
      { tenant_id: orgId },
      {
        $set: {
          feature_flags: foundationFlags,
          feature_flag_mode: 'replace',
          effective_until: expiresAt,
          status: 'active',
          reason: req.body.reason
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 3. Attach the coupon to the tenant's Stripe subscription if any.
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    let stripeApplied = false;
    if (sub?.stripe_subscription_id && isStripeConfigured()) {
      const subCurrency = await currencyForStripeSubscription(sub.stripe_subscription_id);
      const sync = await (await import('../../services/stripeService.js')).ensureStripeCouponForLocal(coupon, { currency: subCurrency });
      if (sync.ok) {
        const apply = await applyCouponToSubscription({
          subscriptionId: sub.stripe_subscription_id,
          couponCode: sync.stripe_coupon_id
        });
        stripeApplied = apply.ok;
      }
    }

    await writeBillingEvent(req, {
      action: 'promo.community_impact_applied',
      targetType: 'tenant',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body.reason,
      metadata: {
        abn: req.body.abn || null,
        abn_verification: abnVerification,
        expires_at: expiresAt,
        stripe_applied: stripeApplied,
        coupon_code: 'COMMUNITY60'
      }
    });
    invalidateEntitlements(orgId);
    res.json({
      success: true,
      data: { coupon_code: 'COMMUNITY60', expires_at: expiresAt, stripe_applied: stripeApplied, abn_verification: abnVerification }
    });
  })
);

/**
 * POST /admin/tenants/:orgId/promo/founding-customer
 * 15% off forever + 24-month price-lock flag in tenant metadata.
 */
router.post(
  '/tenants/:orgId/promo/founding-customer',
  requireSuperAdmin,
  [
    param('orgId').isString().trim().notEmpty(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { OrganizationSubscription, Tenant } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();

    const coupon = await ensureLocalCoupon('FOUNDING15', {
      name: 'Founding Customer — 15% off',
      percent_off: 15,
      duration: 'forever',
      applies_to_plan_codes: [],
      status: 'active'
    });

    const lockUntil = new Date();
    lockUntil.setMonth(lockUntil.getMonth() + 24);
    await Tenant.updateOne(
      { orgId },
      { $set: { 'metadata.founding_customer': true, 'metadata.price_locked_until': lockUntil } }
    );

    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    let stripeApplied = false;
    if (sub?.stripe_subscription_id && isStripeConfigured()) {
      const subCurrency = await currencyForStripeSubscription(sub.stripe_subscription_id);
      const sync = await (await import('../../services/stripeService.js')).ensureStripeCouponForLocal(coupon, { currency: subCurrency });
      if (sync.ok) {
        const apply = await applyCouponToSubscription({
          subscriptionId: sub.stripe_subscription_id,
          couponCode: sync.stripe_coupon_id
        });
        stripeApplied = apply.ok;
      }
    }

    await writeBillingEvent(req, {
      action: 'promo.founding_customer_applied',
      targetType: 'tenant',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body.reason,
      metadata: { price_locked_until: lockUntil, stripe_applied: stripeApplied, coupon_code: 'FOUNDING15' }
    });
    invalidateEntitlements(orgId);
    res.json({ success: true, data: { coupon_code: 'FOUNDING15', price_locked_until: lockUntil, stripe_applied: stripeApplied } });
  })
);

/**
 * POST /admin/tenants/:orgId/promo/volume-group
 * Body: { child_org_ids: string[] (>=4 to qualify, parent + 5 total), reason }
 * Tags the parent tenant + each child with a "volume group" link and
 * attaches a 15% coupon to each subscription.
 */
router.post(
  '/tenants/:orgId/promo/volume-group',
  requireSuperAdmin,
  [
    param('orgId').isString().trim().notEmpty(),
    body('child_org_ids').isArray({ min: 4 }).withMessage('At least 4 children (5 total with parent) required.'),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant, OrganizationSubscription } = getRouterModels();
    const parentOrgId = String(req.params.orgId).toLowerCase();
    const children = (req.body.child_org_ids || []).map((s) => String(s).toLowerCase());

    const coupon = await ensureLocalCoupon('VOLUME15', {
      name: 'Volume / Group — 15% off',
      percent_off: 15,
      duration: 'forever',
      applies_to_plan_codes: [],
      status: 'active'
    });

    const allOrgs = [parentOrgId, ...children];
    const results = [];

    // Tag tenant docs with the volume-group link.
    await Tenant.updateMany(
      { orgId: { $in: allOrgs } },
      { $set: { 'metadata.volume_group_parent': parentOrgId } }
    );

    // Attach the coupon to each tenant's Stripe subscription if any.
    // Each tenant might be on a different currency, so mint (or reuse)
    // the right Stripe coupon per tenant. Percent-off coupons are
    // currency-agnostic so the helper short-circuits to the same id for
    // every tenant — no extra Stripe round-trips.
    if (isStripeConfigured()) {
      const { ensureStripeCouponForLocal } = await import('../../services/stripeService.js');
      for (const orgId of allOrgs) {
        const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
        if (!sub?.stripe_subscription_id) {
          results.push({ orgId, ok: false, error: 'No Stripe subscription' });
          continue;
        }
        const subCurrency = await currencyForStripeSubscription(sub.stripe_subscription_id);
        const stripeSync = await ensureStripeCouponForLocal(coupon, { currency: subCurrency });
        if (!stripeSync.ok) {
          results.push({ orgId, ok: false, error: stripeSync.error || 'Coupon sync failed' });
          continue;
        }
        const apply = await applyCouponToSubscription({
          subscriptionId: sub.stripe_subscription_id,
          couponCode: stripeSync.stripe_coupon_id
        });
        results.push({ orgId, ok: apply.ok, error: apply.error || null });
      }
    }

    await writeBillingEvent(req, {
      action: 'promo.volume_group_applied',
      targetType: 'tenant',
      targetId: parentOrgId,
      targetLabel: parentOrgId,
      tenantId: parentOrgId,
      reason: req.body.reason,
      metadata: {
        children,
        member_count: allOrgs.length,
        coupon_code: 'VOLUME15',
        results
      }
    });
    allOrgs.forEach(invalidateEntitlements);
    res.json({ success: true, data: { parent: parentOrgId, members: allOrgs, results } });
  })
);

// ════════════════════════════════════════════════════════════════════
// TRIAL EXTENSION (handbook §11 — set tenant's trial_ends_at)
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/trial-extend
 * Body: { trial_ends_at (ISO date), reason }
 * Stores the new trial end on the tenant's override and (if a Stripe
 * subscription exists) pushes it to Stripe via subscription.trial_end.
 */
router.post(
  '/tenants/:orgId/trial-extend',
  requireSuperAdmin,
  [
    param('orgId').isString().trim().notEmpty(),
    body('trial_ends_at').isISO8601(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionOverride, OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const trialEndsAt = new Date(req.body.trial_ends_at);
    if (Number.isNaN(trialEndsAt.getTime()) || trialEndsAt.getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TRIAL_DATE', message: 'trial_ends_at must be a future date.' }
      });
    }

    const ov = await SubscriptionOverride.findOneAndUpdate(
      { tenant_id: orgId },
      { $set: { trial_ends_at: trialEndsAt, status: 'active', reason: req.body.reason } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Push to Stripe if there's a live subscription.
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    let stripeUpdated = false;
    if (sub?.stripe_subscription_id && isStripeConfigured()) {
      try {
        const Stripe = await import('stripe');
        const client = new Stripe.default(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-10-28.acacia' });
        await client.subscriptions.update(sub.stripe_subscription_id, {
          trial_end: Math.floor(trialEndsAt.getTime() / 1000),
          proration_behavior: 'none'
        });
        stripeUpdated = true;
      } catch (err) {
        // Surface non-fatal — the override is saved either way.
        console.error('[trial-extend] Stripe update failed:', err?.message || err);
      }
    }

    await writeBillingEvent(req, {
      action: 'subscription.trial_extended',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body.reason,
      metadata: { trial_ends_at: trialEndsAt, stripe_updated: stripeUpdated }
    });
    invalidateEntitlements(orgId);
    res.json({ success: true, data: { trial_ends_at: trialEndsAt, stripe_updated: stripeUpdated, override_id: ov._id } });
  })
);

// ════════════════════════════════════════════════════════════════════
// SUBSCRIPTION PAUSE / RESUME (handbook §3.1, §3.2, §5.9)
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/pause
 * Body: { days (1..90), reason }
 * Pauses Stripe billing for N days. Customer keeps access; Stripe
 * stops invoicing. Auto-resumes after the window.
 */
router.post(
  '/tenants/:orgId/pause',
  requireBillingStaff,
  [
    param('orgId').isString().trim().notEmpty(),
    body('days').isInt({ min: 1, max: 90 }),
    body('reason').isString().trim().isLength({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const { OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No Stripe subscription linked to this tenant.' } });
    }
    const days = Number(req.body.days);
    const result = await pauseSubscription({ subscriptionId: sub.stripe_subscription_id, days });
    if (!result.ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: result.error } });
    }
    await writeBillingEvent(req, {
      action: 'subscription.paused',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body.reason,
      metadata: { days, resumes_at: result.resumes_at, stripe_subscription_id: sub.stripe_subscription_id }
    });
    invalidateEntitlements(orgId);
    res.json({ success: true, data: { paused: true, resumes_at: result.resumes_at, days } });
  })
);

/** POST /admin/tenants/:orgId/resume — resume a paused subscription immediately. */
router.post(
  '/tenants/:orgId/resume',
  requireBillingStaff,
  [
    param('orgId').isString().trim().notEmpty(),
    // Required: resumes billing — auditor needs to know why we ended the pause early.
    body('reason').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Reason is required when resuming a paused subscription.')
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const { OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No Stripe subscription linked to this tenant.' } });
    }
    const result = await resumeSubscription({ subscriptionId: sub.stripe_subscription_id });
    if (!result.ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: result.error } });
    }
    await writeBillingEvent(req, {
      action: 'subscription.resumed',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body?.reason || '',
      metadata: { stripe_subscription_id: sub.stripe_subscription_id }
    });
    invalidateEntitlements(orgId);
    res.json({ success: true, data: { resumed: true } });
  })
);

// ════════════════════════════════════════════════════════════════════
// CYCLE ANCHOR CHANGE (handbook §11)
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/tenants/:orgId/cycle-anchor
 * Body: { anchor_date (ISO date), reason, prorate? }
 *
 * Re-anchors a tenant's billing cycle to a specific calendar day —
 * customer asks for billing on the 1st instead of the 15th.
 */
router.post(
  '/tenants/:orgId/cycle-anchor',
  requireSuperAdmin,
  [
    param('orgId').isString().trim().notEmpty(),
    body('anchor_date').isISO8601(),
    body('reason').isString().trim().isLength({ min: 1, max: 500 }),
    body('prorate').optional().isBoolean()
  ],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' } });
    }
    const { OrganizationSubscription } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const sub = await OrganizationSubscription.findOne({ organization_id: orgId });
    if (!sub?.stripe_subscription_id) {
      return res.status(404).json({ success: false, error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'No Stripe subscription linked to this tenant.' } });
    }
    const anchor = new Date(req.body.anchor_date);
    if (Number.isNaN(anchor.getTime()) || anchor.getTime() < Date.now()) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ANCHOR_DATE', message: 'anchor_date must be a future date.' } });
    }
    const result = await setBillingCycleAnchor({
      subscriptionId: sub.stripe_subscription_id,
      anchorDate: anchor,
      proration: req.body.prorate ? 'create_prorations' : 'none'
    });
    if (!result.ok) {
      return res.status(502).json({ success: false, error: { code: 'STRIPE_ERROR', message: result.error } });
    }
    await writeBillingEvent(req, {
      action: 'subscription.changed',
      targetType: 'subscription',
      targetId: orgId,
      targetLabel: orgId,
      tenantId: orgId,
      reason: req.body.reason,
      metadata: { cycle_anchor: anchor, prorate: !!req.body.prorate }
    });
    invalidateEntitlements(orgId);
    res.json({ success: true, data: { anchor_date: anchor, prorate: !!req.body.prorate } });
  })
);

// ════════════════════════════════════════════════════════════════════
// AUDIT (BillingEvent stream)
// ════════════════════════════════════════════════════════════════════

router.get(
  '/audit',
  [
    query('tenantId').optional().isString().trim(),
    query('action').optional().isString().trim(),
    query('limit').optional().isInt({ min: 1, max: 200 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { BillingEvent } = getRouterModels();
    const limit = parseInt(req.query.limit || '100', 10);
    const filter = {};
    if (req.query.tenantId) filter.tenant_id = String(req.query.tenantId).toLowerCase();
    if (req.query.action) filter.action = String(req.query.action);
    const events = await BillingEvent.find(filter).sort({ created_at: -1 }).limit(limit).lean();
    res.json({ success: true, data: events.map(serializeEvent) });
  })
);

// ════════════════════════════════════════════════════════════════════
// SETTINGS — system-level toggles & defaults
// ════════════════════════════════════════════════════════════════════

// Settings live on a single canonical document keyed by `key='global'`.
// Stored on a generic Mongo collection so we don't need a schema for the
// few static fields the spec calls out.
async function getSettingsDoc() {
  const conn = (await import('../../config/database.js')).getRouterConnection();
  return conn.collection('admin_settings');
}

router.get('/settings', asyncHandler(async (req, res) => {
  const col = await getSettingsDoc();
  const doc = await col.findOne({ key: 'global' });
  res.json({
    success: true,
    data: {
      stripeMode: doc?.stripeMode || 'test',
      defaultSoftCapPct: doc?.defaultSoftCapPct ?? 80,
      defaultHardCapPct: doc?.defaultHardCapPct ?? 100,
      defaultTrialDays: doc?.defaultTrialDays ?? 14,
      overagesGloballyDisabled: !!doc?.overagesGloballyDisabled,
      currency: 'AUD'
    }
  });
}));

router.patch(
  '/settings',
  requireSuperAdmin,
  [
    body('stripeMode').optional().isIn(['test', 'live']),
    body('defaultSoftCapPct').optional().isInt({ min: 50, max: 95 }),
    body('defaultHardCapPct').optional().isInt({ min: 80, max: 200 }),
    body('defaultTrialDays').optional().isInt({ min: 0, max: 90 }),
    body('overagesGloballyDisabled').optional().isBoolean()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const col = await getSettingsDoc();
    const update = { updated_at: new Date(), updated_by: req.user?.userId || null };
    for (const k of ['stripeMode', 'defaultSoftCapPct', 'defaultHardCapPct', 'defaultTrialDays', 'overagesGloballyDisabled']) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) update[k] = req.body[k];
    }
    const before = await col.findOne({ key: 'global' });
    await col.updateOne({ key: 'global' }, { $set: { key: 'global', ...update } }, { upsert: true });

    // Bust every tenant's entitlement cache — settings changes are global.
    invalidateAllEntitlements();

    // Special audit: kill-switch toggles get their own action codes.
    if (Object.prototype.hasOwnProperty.call(req.body, 'overagesGloballyDisabled')) {
      const wasOn = !!before?.overagesGloballyDisabled;
      const isOn = !!req.body.overagesGloballyDisabled;
      if (wasOn !== isOn) {
        await writeBillingEvent(req, {
          action: isOn ? 'system.kill_switch_engaged' : 'system.kill_switch_released',
          targetType: 'settings',
          targetId: 'global',
          targetLabel: 'Disable all overages',
          metadata: { from: wasOn, to: isOn }
        });
      }
    }
    res.json({ success: true });
  })
);

// ── helpers ────────────────────────────────────────────────────────

function serializeCoupon(c) {
  return {
    _id: c._id,
    code: c.code,
    name: c.name || '',
    percent_off: c.percent_off ?? null,
    amount_off_aud: c.amount_off_aud ?? null,
    duration: c.duration,
    duration_in_months: c.duration_in_months ?? null,
    max_redemptions: c.max_redemptions ?? null,
    times_redeemed: c.times_redeemed ?? 0,
    redeem_by: c.redeem_by,
    applies_to_plan_codes: c.applies_to_plan_codes || [],
    status: c.status,
    created_at: c.created_at
  };
}

function serializeEvent(e) {
  return {
    _id: e._id,
    action: e.action,
    target_type: e.target_type,
    target_id: e.target_id,
    target_label: e.target_label,
    tenant_id: e.tenant_id || '',
    actor_id: e.actor_id,
    actor_email: e.actor_email,
    diff: e.diff || [],
    reason: e.reason || '',
    metadata: e.metadata || {},
    status: e.status,
    created_at: e.created_at
  };
}

export default router;
