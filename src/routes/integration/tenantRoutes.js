/**
 * Integration API — Tenants (CRUD + plan assignment + overrides).
 *
 * Read, assign-plan and override endpoints mount the SuperAdmin handlers
 * (routes/admin/opsRoutes.js) behind the API key, so Stripe price swaps,
 * entitlement cache busting and owner notifications behave exactly as they
 * do in the admin portal. Create / update / delete are integration-only.
 *
 * Delete is a soft delete (status → 'deleted'): the tenant DB is kept, the
 * local subscription is cancelled and a live Stripe subscription is set to
 * cancel at period end. PATCH { status: 'active' } reactivates the tenant.
 */

import express from 'express';
import crypto from 'crypto';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { clearTenantCache } from '../../db/router.js';
import { getTenantConnection } from '../../db/connectionManager.js';
import { OrganizationRepository } from '../../repositories/organizationRepository.js';
import authService from '../../services/authService.js';
import { invalidateEntitlements } from '../../services/entitlementService.js';
import { cancelAtPeriodEnd, isStripeConfigured } from '../../services/stripeService.js';
import { password as passwordPolicy } from '../../config/index.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
import {
  listTenantsAction,
  getTenantAction,
  assignPlanAction,
  saveOverrideAction,
  clearOverrideAction
} from '../admin/opsRoutes.js';

const router = express.Router();

const TENANT_STATUSES = ['active', 'suspended', 'deleted'];
const orgIdParam = param('orgId').isString().trim().notEmpty();

const notFound = (res) => res.status(404).json({
  success: false,
  error: { code: 'TENANT_NOT_FOUND', message: 'No such tenant.' }
});

/** A password that satisfies the platform policy (upper, lower, digit, symbol). */
function generateOwnerPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '@#%^_+-=!'];
  const all = sets.join('');
  const length = Math.max(20, passwordPolicy.minLength);
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ── Read (shared admin handlers) ──────────────────────────────────────

router.get('/tenants', asyncHandler(listTenantsAction));
router.get('/tenants/:orgId', [orgIdParam], validate, asyncHandler(getTenantAction));

// ── Create ────────────────────────────────────────────────────────────

/**
 * POST /tenants — provision a new organisation + its owner account via the
 * self-service signup path. `password` is optional; when omitted a policy-
 * compliant one is generated and returned ONCE in the response.
 */
router.post(
  '/tenants',
  [
    body('organizationName').isString().trim().isLength({ min: 2, max: 80 })
      .withMessage('organizationName must be 2–80 characters'),
    body('email').isEmail().withMessage('Valid owner email required').normalizeEmail(),
    body('firstName').isString().trim().isLength({ min: 1, max: 50 }).withMessage('firstName is required'),
    body('lastName').isString().trim().isLength({ min: 1, max: 50 }).withMessage('lastName is required'),
    body('password').optional().isString()
      .isLength({ min: passwordPolicy.minLength })
      .matches(/[A-Z]/).matches(/[a-z]/).matches(/[0-9]/).matches(/[^A-Za-z0-9]/)
      .withMessage('password must include upper, lower, number and special character')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { organizationName, email, firstName, lastName } = req.body;
    const generated = !req.body.password;
    const password = req.body.password || generateOwnerPassword();

    const result = await authService.register({ email, password, organizationName, firstName, lastName });

    await writeBillingEvent(req, {
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: result.orgId,
      targetLabel: organizationName,
      tenantId: result.orgId,
      reason: 'Provisioned via integration API.',
      metadata: { owner_email: email }
    });

    res.status(201).json({
      success: true,
      data: {
        orgId: result.orgId,
        name: organizationName,
        status: 'active',
        owner: result.user,
        // Only present when generated here — not stored or logged anywhere.
        ...(generated ? { ownerPassword: password } : {})
      }
    });
  })
);

// ── Update ────────────────────────────────────────────────────────────

/** PATCH /tenants/:orgId — { status?, name?, reason? }. Responds with tenant detail. */
router.patch(
  '/tenants/:orgId',
  [
    orgIdParam,
    body('status').optional().isIn(TENANT_STATUSES),
    body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
    body('reason').optional().isString()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) return notFound(res);

    const { status, name } = req.body;
    if (status == null && name == null) {
      return res.status(400).json({
        success: false,
        error: { code: 'NOTHING_TO_UPDATE', message: 'Provide status and/or name.' }
      });
    }

    const reason = String(req.body.reason || '').trim();
    if (status && status !== tenant.status) {
      await setTenantStatus(req, tenant, status, reason);
    }

    if (name != null) {
      if (tenant.status !== 'active') {
        return res.status(409).json({
          success: false,
          error: { code: 'TENANT_INACTIVE', message: 'Reactivate the tenant before renaming it.' }
        });
      }
      const orgRepo = new OrganizationRepository(await getTenantConnection(orgId));
      const before = await orgRepo.findOne();
      await orgRepo.update({ name });
      await writeBillingEvent(req, {
        action: 'tenant.updated',
        targetType: 'tenant',
        targetId: orgId,
        targetLabel: name,
        tenantId: orgId,
        diff: [{ path: 'name', from: before?.name ?? null, to: name }],
        reason
      });
    }

    return getTenantAction(req, res);
  })
);

// ── Delete ────────────────────────────────────────────────────────────

/** DELETE /tenants/:orgId — soft delete (status → deleted, subscription cancelled). */
router.delete(
  '/tenants/:orgId',
  [orgIdParam, body('reason').optional().isString()],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant } = getRouterModels();
    const orgId = String(req.params.orgId).toLowerCase();
    const tenant = await Tenant.findOne({ orgId });
    if (!tenant) return notFound(res);

    let stripe = null;
    if (tenant.status !== 'deleted') {
      stripe = await setTenantStatus(req, tenant, 'deleted', String(req.body?.reason || '').trim());
    }
    res.json({ success: true, data: { orgId, status: 'deleted', stripe_cancellation: stripe } });
  })
);

/**
 * Flip the tenant's routing status. Returns the Stripe cancellation result
 * when a delete touched a live Stripe subscription, else null.
 */
async function setTenantStatus(req, tenant, status, reason) {
  const { OrganizationSubscription } = getRouterModels();
  const from = tenant.status;
  tenant.status = status;
  await tenant.save();
  // lookupTenant caches active tenants for up to an hour and entitlements are
  // cached too — drop both so the change takes effect on the next request.
  clearTenantCache(tenant.orgId);
  invalidateEntitlements(tenant.orgId);

  let stripe = null;
  if (status === 'deleted') {
    const sub = await OrganizationSubscription.findOne({ organization_id: tenant.orgId });
    if (sub?.stripe_subscription_id && isStripeConfigured()) {
      const result = await cancelAtPeriodEnd({
        subscriptionId: sub.stripe_subscription_id,
        cancellationDetails: { comment: `Tenant deleted via integration API${reason ? `: ${reason}` : ''}` }
      });
      stripe = { ok: result.ok, error: result.error || null, stripe_subscription_id: sub.stripe_subscription_id };
    }
    if (sub && sub.status !== 'cancelled') {
      sub.status = 'cancelled';
      sub.cancelled_at = new Date();
      if (stripe?.ok) sub.cancel_at_period_end = true;
      await sub.save();
    }
  }

  const action = status === 'active' ? 'tenant.reactivated' : status === 'suspended' ? 'tenant.suspended' : 'tenant.deleted';
  await writeBillingEvent(req, {
    action,
    targetType: 'tenant',
    targetId: tenant.orgId,
    targetLabel: tenant.orgId,
    tenantId: tenant.orgId,
    diff: [{ path: 'status', from, to: status }],
    reason,
    metadata: stripe ? { stripe_cancellation: stripe } : {}
  });
  return stripe;
}

// ── Plan assignment & overrides (shared admin handlers) ───────────────

router.post(
  '/tenants/:orgId/assign-plan',
  [
    orgIdParam,
    body('plan_code').isString().trim().notEmpty(),
    body('billing_cycle').optional().isIn(['monthly', 'yearly']),
    // at_renewal (default) | immediately_prorated | no_migrate — see admin handler.
    body('mode').optional().isIn(['at_renewal', 'immediately_prorated', 'no_migrate']),
    body('reason').optional().isString()
  ],
  validate,
  asyncHandler(assignPlanAction)
);

router.put('/tenants/:orgId/override', [orgIdParam], validate, asyncHandler(saveOverrideAction));
router.delete('/tenants/:orgId/override', [orgIdParam], validate, asyncHandler(clearOverrideAction));

export default router;
