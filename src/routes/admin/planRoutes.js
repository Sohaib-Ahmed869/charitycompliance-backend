/**
 * SuperAdmin plan & feature-flag endpoints.
 *
 * Plans live as a hybrid: in-code defaults (Foundation/Professional/
 * Enterprise) merged at GET time with whatever real Plan documents exist
 * in the Router DB. Editing a default materialises it — first save creates
 * the SubscriptionPlan document and revision 1. Subsequent saves create
 * incremental PlanRevisions with a computed diff.
 *
 * No service or controller layer yet — handlers stay inline. The admin
 * surface is intentionally small until we earn more complexity.
 */

import express from 'express';
import { body, param } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin, requireCalciteStaff } from '../../middleware/requireSuperAdmin.js';
import { detectDangerousPlanDiff, createPendingApproval, countActiveSuperAdmins } from '../../utils/twoPersonApproval.js';
import { syncPlanToStripe, isStripeConfigured } from '../../services/stripeService.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
// NOTE: Plan PATCH does NOT bust tenant entitlement caches by design —
// pinning means existing tenants keep their old revision until a SuperAdmin
// runs POST /admin/plans/:code/migrate-revision (see opsRoutes.js).
import {
  DEFAULT_PLANS,
  DEFAULT_FEATURE_FLAGS,
  mergePlansWithTemplates,
  findTemplateByCode,
  feature_flags_default_map
} from '../../utils/defaultPlans.js';

const router = express.Router();

/**
 * Hard cap on the number of plans that can simultaneously be both
 * `visibility: 'public'` AND `status: 'active'`. The marketing pricing
 * page renders horizontally and only has room for four cards — letting
 * a fifth in would silently truncate the catalogue on a 1440px screen
 * and look broken on anything narrower. Enforced at the API layer so it
 * survives super-admins editing plans directly via the JSON endpoint.
 */
const MAX_PUBLIC_ACTIVE_PLANS = 4;

/**
 * Returns the current count of public+active plans, optionally excluding
 * a specific plan code (so a PATCH on an already-public-active plan
 * doesn't see itself in the count).
 */
async function countPublicActivePlans(excludeCode = null) {
  const { SubscriptionPlan } = getRouterModels();
  const q = { visibility: 'public', status: 'active' };
  if (excludeCode) q.plan_code = { $ne: String(excludeCode).toLowerCase() };
  return SubscriptionPlan.countDocuments(q);
}

router.use(authenticate);
// All Calcite staff can READ plans + feature catalogue + matrix.
// Mutating endpoints add requireSuperAdmin individually.
router.use(requireCalciteStaff);

// ── Plans ─────────────────────────────────────────────────────────────

/** GET /admin/plans — DB plans + templates, sorted by sortOrder. */
router.get('/plans', asyncHandler(async (req, res) => {
  const { SubscriptionPlan } = getRouterModels();
  const dbPlans = await SubscriptionPlan
    .find({})
    .sort({ 'metadata.sortOrder': 1, plan_code: 1 })
    .lean();
  const merged = mergePlansWithTemplates(dbPlans.map(serializePlan));
  // `meta.public_active_count` lets the UI disable the "New plan" button
  // and surface a callout when the catalogue has hit MAX_PUBLIC_ACTIVE_PLANS.
  // We count from the merged list (DB + templates) because an unmaterialised
  // template still occupies a slot on the customer-facing pricing page.
  const publicActiveCount = merged.filter((p) => (p.visibility || 'public') === 'public' && (p.status || 'active') === 'active').length;
  res.json({
    success: true,
    data: merged,
    meta: {
      public_active_count: publicActiveCount,
      public_active_cap: MAX_PUBLIC_ACTIVE_PLANS
    }
  });
}));

/** GET /admin/plans/:code — DB plan + revisions, or template if not yet saved. */
router.get(
  '/plans/:code',
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const plan = await SubscriptionPlan.findOne({ plan_code: code }).lean();
    if (plan) {
      const revisions = await PlanRevision
        .find({ plan_id: plan._id })
        .sort({ revision_number: -1 })
        .limit(50)
        .lean();
      return res.json({
        success: true,
        data: { ...serializePlan(plan), is_template: false, revisions: revisions.map(serializeRevision) }
      });
    }
    // Not yet saved — return the template (if any) so the UI can render it.
    const template = findTemplateByCode(code);
    if (template) {
      return res.json({
        success: true,
        data: { ...template, _id: null, is_template: true, current_revision: 0, revisions: [] }
      });
    }
    return res.status(404).json({
      success: false,
      error: { code: 'PLAN_NOT_FOUND', message: 'No such plan.' }
    });
  })
);

/**
 * PATCH /admin/plans/:code — apply a structured patch.
 *
 * Body is the full new plan shape (pricing/limits/feature_flags/support/
 * trial_days/metadata/visibility/status/name). We compute a diff against
 * the previous snapshot, persist a new PlanRevision, and update the Plan.
 * If the plan was a template (no DB record yet), this is the
 * materialisation moment — we create the document and revision 1.
 */
router.patch(
  '/plans/:code',
  requireSuperAdmin,
  [
    param('code').isString().trim().notEmpty(),
    // Required: plan edits + archives change every tenant's commercial
    // terms once they migrate. Auditors need to know why.
    body('reason').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Reason is required.')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const code = String(req.params.code).toLowerCase();
    const patch = req.body || {};
    const reason = String(patch.reason || '').trim();

    // Public-active cap: if this patch would move the plan INTO the
    // public+active bucket (either materialising a template as public+
    // active, or flipping an existing private/archived plan), reject if
    // that would push the catalogue over MAX_PUBLIC_ACTIVE_PLANS.
    {
      const { SubscriptionPlan: SPCount } = getRouterModels();
      const existing = await SPCount.findOne({ plan_code: code }).lean();
      const prevPublicActive = existing
        ? (existing.visibility === 'public' && existing.status === 'active')
        : (() => {
            const tpl = findTemplateByCode(code);
            return tpl && (tpl.visibility || 'public') === 'public' && (tpl.status || 'active') === 'active';
          })();
      const nextVisibility = patch.visibility || existing?.visibility || findTemplateByCode(code)?.visibility || 'public';
      const nextStatus = patch.status || existing?.status || findTemplateByCode(code)?.status || 'active';
      const nextPublicActive = nextVisibility === 'public' && nextStatus === 'active';
      if (nextPublicActive && !prevPublicActive) {
        const dbPlans = await SPCount.find({}).lean();
        const merged = mergePlansWithTemplates(dbPlans.map(serializePlan));
        const currentPublicActive = merged.filter(
          (p) => p.code !== code && (p.visibility || 'public') === 'public' && (p.status || 'active') === 'active'
        ).length;
        if (currentPublicActive + 1 > MAX_PUBLIC_ACTIVE_PLANS) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'PUBLIC_PLAN_CAP_REACHED',
              message: `The customer-facing pricing page can only show ${MAX_PUBLIC_ACTIVE_PLANS} plans. Archive or hide an existing public plan before activating another.`,
              details: { cap: MAX_PUBLIC_ACTIVE_PLANS, current: currentPublicActive }
            }
          });
        }
      }
    }

    // Two-person approval gate (handbook §7.3): if the proposed update
    // would raise a price, reduce a quota, or remove a feature, we DO
    // NOT execute. We stash the payload in a pending BillingEvent and
    // wait for a different super-admin to approve.
    //
    // Materialisation (no prevSnapshot) is exempt — first save isn't a
    // change of an existing live plan. Templates have always been
    // configurable via the same form.
    const { SubscriptionPlan: SP } = getRouterModels();
    const existingPlan = await SP.findOne({ plan_code: code }).lean();
    if (existingPlan) {
      const prevSnap = serializePlan(existingPlan);
      const proposedSnap = projectPlanUpdate(prevSnap, patch);
      const dangers = detectDangerousPlanDiff(prevSnap, proposedSnap);
      const skipApproval = patch.__approvedReplay === true; // set only by the approve handler
      if (dangers.length && !skipApproval) {
        // Two-person rule needs two people. If only one active super-
        // admin exists in the system, gating would deadlock — apply
        // immediately but stamp the audit row so it's visible in review
        // and the requester is nudged to add a second super-admin.
        const superAdminCount = await countActiveSuperAdmins();
        if (superAdminCount <= 1) {
          const result = await applyPlanPatch({
            req, code, patch, reason,
            autoAppliedNoSecondApprover: true,
            autoAppliedDangers: dangers
          });
          if (result.error) return res.status(result.statusCode).json({ success: false, error: result.error });
          return res.json({
            success: true,
            data: {
              ...result.data,
              auto_applied_no_second_approver: true,
              auto_applied_dangers: dangers,
              message: 'Applied without second approver — only one active super-admin exists. Add a second super-admin to restore two-person approval for future dangerous changes.'
            }
          });
        }
        const evt = await createPendingApproval(req, {
          action: 'plan.update_pending',
          targetType: 'plan',
          targetId: code,
          targetLabel: existingPlan.plan_name,
          reason,
          diff: computeDiff(prevSnap, proposedSnap),
          pendingPayload: { code, body: patch },
          pendingDangers: dangers
        });
        return res.status(202).json({
          success: true,
          data: {
            pending: true,
            approval_id: evt._id,
            dangers,
            message: 'Submitted for second-admin approval. The change has not been applied.'
          }
        });
      }
    }

    const result = await applyPlanPatch({ req, code, patch, reason });
    if (result.error) return res.status(result.statusCode).json({ success: false, error: result.error });
    return res.json({ success: true, data: result.data });
  })
);

/**
 * Compute what the plan snapshot WOULD look like after the patch is
 * applied — without touching the DB. Used to feed
 * `detectDangerousPlanDiff` so we can decide whether to gate the write
 * behind two-person approval before we write anything.
 */
function projectPlanUpdate(prevSnap, patch) {
  const proposed = { ...prevSnap };
  if (patch.name) proposed.name = patch.name;
  if (patch.visibility) proposed.visibility = patch.visibility;
  if (patch.status) proposed.status = patch.status;
  if (patch.pricing) proposed.pricing = { ...prevSnap.pricing, ...patch.pricing };
  if (patch.limits)  proposed.limits  = { ...prevSnap.limits,  ...patch.limits  };
  if (patch.feature_flags) proposed.feature_flags = { ...prevSnap.feature_flags, ...patch.feature_flags };
  if (patch.support) proposed.support = { ...prevSnap.support, ...patch.support };
  if (patch.trial_days != null) proposed.trial_days = patch.trial_days;
  if (patch.is_contact_sales != null) proposed.is_contact_sales = !!patch.is_contact_sales;
  if (patch.metadata) proposed.metadata = { ...prevSnap.metadata, ...patch.metadata };
  return proposed;
}

/**
 * Apply a plan patch. Extracted so the approve-handler can call it
 * directly when a pending event is approved by a second super-admin.
 *
 * Returns either { data } on success or { error, statusCode } on failure.
 */
export async function applyPlanPatch({ req, code, patch, reason = '', autoAppliedNoSecondApprover = false, autoAppliedDangers = [] }) {
  const { SubscriptionPlan, PlanRevision } = getRouterModels();
  const editorId = req?.user?.userId || null;

  const editable = ['name', 'visibility', 'status', 'pricing', 'limits', 'feature_flags', 'support', 'trial_days', 'is_contact_sales', 'metadata'];
  const cleaned = {};
  for (const k of editable) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) cleaned[k] = patch[k];
  }

  // Annual price is derived, not hand-entered: whenever a pricing patch
  // carries a monthly price and an annual-discount %, recompute annualAUD
  // = monthly × 12 × (1 − pct/100). This keeps the discount the single
  // source of truth and feeds the value Stripe is synced to below.
  if (cleaned.pricing && typeof cleaned.pricing === 'object') {
    const monthly = Number(cleaned.pricing.monthlyAUD);
    const disc = Number(cleaned.pricing.annualDiscountPct);
    if (Number.isFinite(monthly) && Number.isFinite(disc)) {
      cleaned.pricing.annualAUD = Math.max(0, Math.round(monthly * 12 * (1 - disc / 100)));
    }
  }

  const update = {};
  if (cleaned.name) update.plan_name = cleaned.name;
  if (cleaned.visibility) update.visibility = cleaned.visibility;
  if (cleaned.status) update.status = cleaned.status;
  if (cleaned.pricing) update.pricing = cleaned.pricing;
  if (cleaned.limits) update.limits = cleaned.limits;
  if (cleaned.feature_flags) update.feature_flags = cleaned.feature_flags;
  if (cleaned.support) update.support = cleaned.support;
  if (cleaned.trial_days != null) update.trial_days = cleaned.trial_days;
  if (cleaned.is_contact_sales != null) update.is_contact_sales = !!cleaned.is_contact_sales;
  if (cleaned.metadata) update.metadata = cleaned.metadata;
  if (cleaned.pricing?.monthlyAUD != null) update.monthly_price = Number(cleaned.pricing.monthlyAUD);
  if (cleaned.pricing?.annualAUD != null)  update.yearly_price  = Number(cleaned.pricing.annualAUD);

  let plan = await SubscriptionPlan.findOne({ plan_code: code });
  let prevSnapshot = null;
  let nextRevisionNumber = 1;

  if (!plan) {
    const template = findTemplateByCode(code);
    if (!template) {
      return { error: { code: 'PLAN_NOT_FOUND', message: 'No template or saved plan with that code.' }, statusCode: 404 };
    }
    const initial = templateToDocument(template);
    Object.assign(initial, update);
    initial.plan_code = code;
    initial.current_revision = 1;
    initial.updated_by = editorId;
    plan = await SubscriptionPlan.create(initial);
  } else {
    prevSnapshot = serializePlan(plan.toObject());
    nextRevisionNumber = (plan.current_revision || 0) + 1;
    Object.assign(plan, update);
    plan.current_revision = nextRevisionNumber;
    plan.updated_by = editorId;
    if (cleaned.feature_flags) plan.markModified('feature_flags');
    await plan.save();
  }

  // Auto-sync to Stripe whenever pricing was part of this patch, or on a
  // plan's first materialisation (so a freshly-saved plan is immediately
  // self-checkout-ready). syncPlanAndPersist stamps the Stripe IDs back
  // onto `plan` and saves, so the revision snapshot below captures them.
  let stripeSync = null;
  if (cleaned.pricing || !prevSnapshot) {
    stripeSync = await syncPlanAndPersist(plan, req);
  }

  const newSnapshot = serializePlan(plan.toObject());
  const diff = computeDiff(prevSnapshot, newSnapshot);

  await PlanRevision.create({
    plan_id: plan._id,
    plan_code: plan.plan_code,
    revision_number: nextRevisionNumber,
    snapshot: newSnapshot,
    diff,
    reason,
    changed_by: editorId,
    changed_at: new Date()
  });

  const revisions = await PlanRevision
    .find({ plan_id: plan._id })
    .sort({ revision_number: -1 })
    .limit(50)
    .lean();

  await writeBillingEvent(req, {
    action: prevSnapshot ? 'plan.updated' : 'plan.materialised',
    targetType: 'plan',
    targetId: plan.plan_code,
    targetLabel: plan.plan_name,
    diff,
    reason,
    metadata: {
      revision: nextRevisionNumber,
      ...(autoAppliedNoSecondApprover ? {
        auto_applied_no_second_approver: true,
        auto_applied_dangers: autoAppliedDangers
      } : {})
    }
  });

  return {
    data: {
      ...newSnapshot,
      is_template: false,
      revisions: revisions.map(serializeRevision),
      stripe_sync: summarizeSync(stripeSync)
    }
  };
}

/**
 * POST /admin/plans — create a brand-new custom plan from scratch (or
 * forked from another). Body must include at least `code` + `name`.
 */
router.post(
  '/plans',
  requireSuperAdmin,
  [
    body('code').isString().trim().isLength({ min: 2, max: 64 }).matches(/^[a-z0-9][a-z0-9_-]*$/),
    body('name').isString().trim().isLength({ min: 1, max: 80 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan, PlanRevision } = getRouterModels();
    const code = String(req.body.code).toLowerCase().trim();
    const name = String(req.body.name).trim();

    const exists = await SubscriptionPlan.findOne({ plan_code: code });
    if (exists) {
      return res.status(409).json({
        success: false,
        error: { code: 'PLAN_CODE_TAKEN', message: 'A plan with that code already exists.' }
      });
    }
    if (findTemplateByCode(code)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'PLAN_CODE_RESERVED',
          message: 'That code is reserved for a default template — edit the template instead.'
        }
      });
    }

    // Enforce the public-active cap. A brand-new plan defaults to private
    // unless the caller explicitly requested public, so we only count
    // when the create would land in the public+active bucket. Templates
    // that haven't been materialised yet (e.g. a default Bespoke tier the
    // admin hasn't customised) DO already occupy a slot on the marketing
    // page, so they're included in the count.
    const requestedVisibility = String(req.body.visibility || 'private').toLowerCase();
    if (requestedVisibility === 'public') {
      const { SubscriptionPlan: SP2 } = getRouterModels();
      const dbPlans = await SP2.find({}).lean();
      const merged = mergePlansWithTemplates(dbPlans.map(serializePlan));
      const publicActive = merged.filter((p) => (p.visibility || 'public') === 'public' && (p.status || 'active') === 'active').length;
      if (publicActive >= MAX_PUBLIC_ACTIVE_PLANS) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'PUBLIC_PLAN_CAP_REACHED',
            message: `The customer-facing pricing page can only show ${MAX_PUBLIC_ACTIVE_PLANS} plans. Archive or hide an existing public plan before adding another.`,
            details: { cap: MAX_PUBLIC_ACTIVE_PLANS, current: publicActive }
          }
        });
      }
    }

    // Optional fork: copy fields from another plan (template or DB).
    const forkFromCode = String(req.body.fork_from || '').toLowerCase().trim();
    let base = null;
    if (forkFromCode) {
      const forkDb = await SubscriptionPlan.findOne({ plan_code: forkFromCode }).lean();
      base = forkDb ? serializePlan(forkDb) : findTemplateByCode(forkFromCode);
    }
    const initial = base ? templateToDocument(base) : blankPlanDocument();
    initial.plan_code = code;
    initial.plan_name = name;
    initial.visibility = req.body.visibility || initial.visibility || 'private';
    initial.status = 'active';
    if (req.body.is_contact_sales != null) initial.is_contact_sales = !!req.body.is_contact_sales;
    initial.current_revision = 1;
    initial.updated_by = req.user?.userId || null;

    const created = await SubscriptionPlan.create(initial);

    // Auto-provision the Stripe Product + monthly/annual Prices so the
    // plan is self-checkout-ready the moment it's created — no manual
    // "go to Stripe, copy the price IDs" step. Best-effort: a Stripe
    // failure does not roll back plan creation (the manual Sync button,
    // or the next price edit, retries).
    const stripeSync = await syncPlanAndPersist(created, req);

    // Serialize AFTER the sync so the revision-1 snapshot captures the
    // freshly-stamped Stripe IDs.
    const snapshot = serializePlan(created.toObject());
    await PlanRevision.create({
      plan_id: created._id,
      plan_code: created.plan_code,
      revision_number: 1,
      snapshot,
      diff: [],
      reason: forkFromCode ? `Created (forked from ${forkFromCode}).` : 'Created.',
      changed_by: req.user?.userId || null,
      changed_at: new Date()
    });
    await writeBillingEvent(req, {
      action: 'plan.created',
      targetType: 'plan',
      targetId: created.plan_code,
      targetLabel: created.plan_name,
      reason: forkFromCode ? `Forked from ${forkFromCode}.` : 'Created.',
      metadata: { fork_from: forkFromCode || null }
    });

    return res.status(201).json({
      success: true,
      data: { ...snapshot, is_template: false, revisions: [], stripe_sync: summarizeSync(stripeSync) }
    });
  })
);

/** POST /admin/plans/:code/archive — flip status to archived. */
router.post(
  '/plans/:code/archive',
  requireSuperAdmin,
  [
    param('code').isString().trim().notEmpty(),
    // Required: plan edits + archives change every tenant's commercial
    // terms once they migrate. Auditors need to know why.
    body('reason').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Reason is required.')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SubscriptionPlan: SP } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const reason = String(req.body?.reason || 'Archived.').trim();
    const plan = await SP.findOne({ plan_code: code }).lean();
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'Cannot archive a plan that has never been saved.' }
      });
    }
    if (plan.status === 'archived') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_ARCHIVED', message: 'This plan is already archived.' }
      });
    }

    // Plan archival is a two-person-rule action (handbook §7.3 +
    // architecture §11): existing subscribers stay on their pinned
    // revision so it's not destructive, but it's irreversible commercially
    // (no new sign-ups) and warrants a second pair of eyes.
    const skipApproval = req.body?.__approvedReplay === true;
    if (!skipApproval) {
      const superAdminCount = await countActiveSuperAdmins();
      if (superAdminCount <= 1) {
        const result = await applyPlanArchive({
          req, code, reason,
          autoAppliedNoSecondApprover: true
        });
        if (result.error) return res.status(result.statusCode || 500).json({ success: false, error: result.error });
        return res.json({
          success: true,
          data: {
            ...result.data,
            auto_applied_no_second_approver: true,
            auto_applied_dangers: ['plan_archive'],
            message: 'Archived without second approver — only one active super-admin exists. Add a second super-admin to restore two-person approval for future dangerous changes.'
          }
        });
      }
      const evt = await createPendingApproval(req, {
        action: 'plan.archive_pending',
        targetType: 'plan',
        targetId: code,
        targetLabel: plan.plan_name,
        reason,
        diff: [{ path: 'status', from: plan.status, to: 'archived' }],
        pendingPayload: { code, reason },
        pendingDangers: ['plan_archive']
      });
      return res.status(202).json({
        success: true,
        data: {
          pending: true,
          approval_id: evt._id,
          dangers: ['plan_archive'],
          message: 'Submitted for second-admin approval. The plan has not been archived.'
        }
      });
    }

    const result = await applyPlanArchive({ req, code, reason });
    if (result.error) return res.status(result.statusCode).json({ success: false, error: result.error });
    return res.json({ success: true, data: result.data });
  })
);

/**
 * Apply the actual archive — extracted so the approve handler can call
 * it after a second super-admin signs off.
 */
export async function applyPlanArchive({ req, code, reason = 'Archived.', autoAppliedNoSecondApprover = false }) {
  const { SubscriptionPlan, PlanRevision } = getRouterModels();
  const plan = await SubscriptionPlan.findOne({ plan_code: code });
  if (!plan) {
    return { error: { code: 'PLAN_NOT_FOUND', message: 'Cannot archive a plan that has never been saved.' }, statusCode: 404 };
  }
  const prev = serializePlan(plan.toObject());
  plan.status = 'archived';
  plan.is_active = false;
  plan.current_revision = (plan.current_revision || 0) + 1;
  plan.updated_by = req?.user?.userId || null;
  await plan.save();
  const next = serializePlan(plan.toObject());
  await PlanRevision.create({
    plan_id: plan._id,
    plan_code: plan.plan_code,
    revision_number: plan.current_revision,
    snapshot: next,
    diff: computeDiff(prev, next),
    reason,
    changed_by: req?.user?.userId || null,
    changed_at: new Date()
  });
  await writeBillingEvent(req, {
    action: 'plan.archived',
    targetType: 'plan',
    targetId: plan.plan_code,
    targetLabel: plan.plan_name,
    reason,
    metadata: autoAppliedNoSecondApprover
      ? { auto_applied_no_second_approver: true, auto_applied_dangers: ['plan_archive'] }
      : {}
  });
  return { data: { ...next, is_template: false } };
}

// ── Feature flags ─────────────────────────────────────────────────────

/**
 * POST /admin/plans/:code/sync-stripe
 * Mints (or retrieves) the Stripe Product + monthly/annual Prices for
 * this plan and stamps the IDs back onto the plan doc. Idempotent.
 */
router.post(
  '/plans/:code/sync-stripe',
  requireSuperAdmin,
  [param('code').isString().trim().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({
        success: false,
        error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Stripe is not configured.' }
      });
    }
    const { SubscriptionPlan } = getRouterModels();
    const code = String(req.params.code).toLowerCase();
    const plan = await SubscriptionPlan.findOne({ plan_code: code });
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_NOT_FOUND', message: 'Save the plan first before syncing.' }
      });
    }

    // Same code-path the auto-sync on plan create/update uses — stamps
    // the Stripe Product/Price IDs back onto the plan doc and audits it.
    const result = await syncPlanAndPersist(plan, req);
    if (!result.ok) {
      return res.status(502).json({
        success: false,
        error: { code: 'STRIPE_ERROR', message: result.error || 'Sync failed.' }
      });
    }

    res.json({ success: true, data: { ...result, plan_code: plan.plan_code } });
  })
);

/**
 * GET /admin/feature-flags — DB-backed catalogue, with the in-code
 * defaults filling in anything not yet persisted. Same template-merge
 * pattern as plans, so a fresh DB just shows the canonical 40 flags.
 */
router.get('/feature-flags', asyncHandler(async (req, res) => {
  const { FeatureFlag } = getRouterModels();
  const dbFlags = await FeatureFlag.find({}).sort({ category: 1, code: 1 }).lean();
  const byCode = new Map(dbFlags.map((f) => [f.code, f]));
  const merged = DEFAULT_FEATURE_FLAGS.map(([code, category, name, tiers, description, sidebar]) => {
    const db = byCode.get(code);
    return db
      ? { code: db.code, category: db.category, name: db.name, description: db.description || description || '', status: db.status, is_template: false, default_tiers: tiers || [], sidebar: sidebar || [] }
      : { code, category, name, description: description || '', status: 'active', is_template: true, default_tiers: tiers || [], sidebar: sidebar || [] };
  });
  // Surface any DB-only flags (custom-added beyond the catalogue) at the end.
  for (const db of dbFlags) {
    if (!merged.some((m) => m.code === db.code)) {
      merged.push({ code: db.code, category: db.category, name: db.name, description: db.description || '', status: db.status, is_template: false, default_tiers: [], sidebar: [] });
    }
  }
  res.json({ success: true, data: merged });
}));

/**
 * GET /admin/feature-matrix
 *
 * Returns a flag × plan grid so SuperAdmin can audit at a glance which
 * features are enabled where. Includes:
 *   - features[]      — full catalogue (code, name, description, sidebar, default_tiers)
 *   - plans[]         — every plan in the catalogue (Foundation/Pro/Ent + custom)
 *   - matrix[code][plan_code] = boolean (true if plan grants the flag)
 *   - override_counts[code]   = number of tenants with an explicit override
 */
router.get('/feature-matrix', asyncHandler(async (req, res) => {
  const { SubscriptionPlan, SubscriptionOverride } = getRouterModels();

  // Plans (DB + templates merged)
  const dbPlans = await SubscriptionPlan
    .find({})
    .sort({ 'metadata.sortOrder': 1, plan_code: 1 })
    .lean();
  const merged = mergePlansWithTemplates(dbPlans.map(serializePlan));
  const plans = merged.filter((p) => p.status !== 'archived').map((p) => ({
    code: p.code,
    name: p.name,
    is_template: !!p.is_template,
    visibility: p.visibility,
    feature_flags: p.feature_flags || {}
  }));

  // Catalogue
  const features = DEFAULT_FEATURE_FLAGS.map(([code, category, name, tiers, description, sidebar]) => ({
    code, category, name, description: description || '', default_tiers: tiers || [], sidebar: sidebar || []
  }));

  // Matrix lookup
  const matrix = {};
  for (const f of features) {
    matrix[f.code] = {};
    for (const p of plans) {
      matrix[f.code][p.code] = p.feature_flags?.[f.code] === true;
    }
  }

  // Per-flag count of tenants with an explicit override (forced ON or OFF).
  const overrides = await SubscriptionOverride.find({}).lean();
  const overrideCounts = {};
  for (const f of features) overrideCounts[f.code] = 0;
  for (const ov of overrides) {
    const flags = ov.feature_flags instanceof Map
      ? Object.fromEntries(ov.feature_flags)
      : (ov.feature_flags || {});
    for (const code of Object.keys(flags)) {
      if (flags[code] === true || flags[code] === false) {
        overrideCounts[code] = (overrideCounts[code] || 0) + 1;
      }
    }
  }

  res.json({
    success: true,
    data: { features, plans, matrix, override_counts: overrideCounts }
  });
}));

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Sync a saved plan to Stripe and stamp the resulting Product / Price IDs
 * back onto the plan document. The single code-path shared by plan
 * create, plan update, and the manual "Sync to Stripe" button.
 *
 * Best-effort by contract: a Stripe failure (or Stripe not configured) is
 * returned as { ok: false, ... } and NEVER throws — a plan create/update
 * must not be rolled back because Stripe had a bad day.
 *
 * `planDoc` is a live Mongoose document — it gets mutated and saved here.
 */
async function syncPlanAndPersist(planDoc, req) {
  if (!isStripeConfigured()) {
    return { ok: false, skipped: true, error: 'Stripe is not configured.' };
  }
  try {
    const result = await syncPlanToStripe(planDoc.toObject());
    if (!result.ok) return result;

    // Set the three fields in place rather than rebuilding `pricing` —
    // spreading the Mongoose nested path drops sub-objects like
    // overageRatesAUD / stripeOverageMeters, which then fail schema cast
    // on save ("Cast to Object failed for value undefined").
    planDoc.pricing.stripeProductId = result.productId || planDoc.pricing.stripeProductId || '';
    planDoc.pricing.stripeMonthlyPriceId = result.monthlyPriceId || '';
    planDoc.pricing.stripeAnnualPriceId = result.annualPriceId || '';
    planDoc.markModified('pricing');
    await planDoc.save();

    await writeBillingEvent(req, {
      action: 'plan.synced_to_stripe',
      targetType: 'plan',
      targetId: planDoc.plan_code,
      targetLabel: planDoc.plan_name,
      metadata: {
        stripe_product_id: result.productId,
        stripe_monthly_price_id: result.monthlyPriceId,
        stripe_annual_price_id: result.annualPriceId,
        created: result.created,
        archived: result.archived || []
      }
    });
    return result;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Compact, frontend-friendly summary of a syncPlanAndPersist result. */
function summarizeSync(result) {
  if (!result) return null;
  if (result.skipped) {
    return { ok: false, skipped: true, message: 'Stripe not configured — IDs not provisioned.' };
  }
  if (!result.ok) {
    return { ok: false, message: result.error || 'Stripe sync failed — use "Sync to Stripe" to retry.' };
  }
  return {
    ok: true,
    product_id: result.productId,
    monthly_price_id: result.monthlyPriceId,
    annual_price_id: result.annualPriceId,
    created: result.created,
    archived: result.archived || []
  };
}

function serializePlan(p) {
  if (!p) return null;
  const featureFlags = p.feature_flags instanceof Map
    ? Object.fromEntries(p.feature_flags)
    : (p.feature_flags || {});
  return {
    _id: p._id || null,
    code: p.plan_code || p.code,
    name: p.plan_name || p.name,
    visibility: p.visibility || 'public',
    status: p.status || 'active',
    pricing: p.pricing || {},
    limits: p.limits || {},
    feature_flags: featureFlags,
    support: p.support || {},
    trial_days: p.trial_days ?? 14,
    is_contact_sales: !!p.is_contact_sales,
    metadata: p.metadata || {},
    current_revision: p.current_revision ?? 1,
    created_at: p.created_at,
    updated_at: p.updated_at
  };
}

function serializeRevision(r) {
  return {
    _id: r._id,
    revision_number: r.revision_number,
    diff: r.diff || [],
    reason: r.reason || '',
    changed_by: r.changed_by,
    changed_at: r.changed_at
  };
}

/** Convert a template (or another plan) into the SubscriptionPlan document shape. */
function templateToDocument(t) {
  return {
    plan_code: t.code,
    plan_name: t.name,
    visibility: t.visibility || 'public',
    status: t.status || 'active',
    is_active: (t.status || 'active') === 'active',
    pricing: { ...(t.pricing || {}) },
    limits: { ...(t.limits || {}) },
    feature_flags: { ...(t.feature_flags || {}) },
    support: { ...(t.support || {}) },
    trial_days: t.trial_days ?? 14,
    is_contact_sales: !!t.is_contact_sales,
    metadata: { ...(t.metadata || {}) },
    monthly_price: Number(t.pricing?.monthlyAUD || 0),
    yearly_price: Number(t.pricing?.annualAUD || 0)
  };
}

/** Skeleton for a brand-new custom plan (POST /admin/plans without fork). */
function blankPlanDocument() {
  return {
    plan_code: '',
    plan_name: '',
    visibility: 'private',
    status: 'active',
    is_active: true,
    pricing: { monthlyAUD: 0, annualAUD: 0, setupFeeMonthlyAUD: 0, setupFeeAnnualAUD: 0, overagePerWorkflowAUD: null, currency: 'AUD' },
    limits: { staffSeats: 5, boardSeats: 5, workflowsPerMonth: 50, storageGB: 10, apiCallsPerDay: 0, customWorkflows: 0, childEntities: 0, softCapPct: 80, hardCapPct: 100 },
    feature_flags: feature_flags_default_map(),
    support: { channel: 'email', responseSLAHours: 48, uptimeSLAPct: null },
    trial_days: 14,
    is_contact_sales: false,
    metadata: { description: '', targetCustomer: '', sortOrder: 100 },
    monthly_price: 0,
    yearly_price: 0
  };
}

/**
 * Compute a flat diff list of [path, from, to] tuples between two plan
 * snapshots. Recursive on nested objects (pricing/limits/etc.); short-
 * circuits on equal scalars and equal JSON-stringified subtrees.
 */
function computeDiff(prev, next, prefix = '') {
  if (!prev) return [];
  const out = [];
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const k of keys) {
    if (k === 'revisions' || k === '_id' || k === 'is_template' || k === 'created_at' || k === 'updated_at' || k === 'current_revision') continue;
    const a = prev?.[k];
    const b = next?.[k];
    const path = prefix ? `${prefix}.${k}` : k;
    const aJson = JSON.stringify(a);
    const bJson = JSON.stringify(b);
    if (aJson === bJson) continue;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      out.push(...computeDiff(a, b, path));
    } else {
      out.push({ path, from: a ?? null, to: b ?? null });
    }
  }
  return out;
}

export default router;
