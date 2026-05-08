/**
 * Entitlement Resolver — the merge engine that turns
 *   plan defaults  +  pinned PlanRevision  +  SubscriptionOverride
 * into a single normalized "what is org X allowed to do?" object.
 *
 * Called by:
 *   - tenant /platform/billing/me  (read what the tenant sees)
 *   - requireFeatureFlag middleware (gate a route)
 *   - enforceLimit middleware (cap usage)
 *
 * Cached per-orgId for ENTITLEMENT_CACHE_TTL_MS (60s default). Cache is
 * invalidated by SuperAdmin writes — see invalidateEntitlements() and
 * the call sites in opsRoutes.js / planRoutes.js.
 *
 * No mongoose model registration here — pulls from getRouterModels() so
 * the resolver works on the shared Router connection without owning any
 * tenant DB state.
 */

import NodeCache from 'node-cache';
import getRouterModels from '../db/models/routerModels.js';
import { findTemplateByCode } from '../utils/defaultPlans.js';

const ENTITLEMENT_CACHE_TTL_S = Number(process.env.ENTITLEMENT_CACHE_TTL_S || 60);

const cache = new NodeCache({ stdTTL: ENTITLEMENT_CACHE_TTL_S, useClones: false });

/**
 * Public API — resolve effective entitlements for a tenant.
 *
 * Returns a normalized object (never null) with sensible defaults if the
 * tenant has no subscription so callers always get a usable shape.
 *
 *   {
 *     plan_code, plan_name, revision_number,
 *     limits:        { staffSeats, boardSeats, workflowsPerMonth, ... },
 *     feature_flags: { 'partner_vetting': true, ... },
 *     pricing:       { monthlyAUD, annualAUD, ... },
 *     support:       { channel, responseSLAHours, uptimeSLAPct },
 *     status:        'active' | 'past_due' | 'cancelled' | 'no_subscription',
 *     has_override:  boolean,
 *     overage_kill_switch: boolean,
 *     trial_days:    number,
 *     billing_cycle: 'monthly' | 'yearly' | null,
 *     current_period_end: Date | null,
 *     cancel_at_period_end: boolean
 *   }
 */
export async function resolveEntitlements(orgId) {
  if (!orgId) throw new Error('resolveEntitlements: orgId required');
  const key = String(orgId).toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const fresh = await computeEntitlements(key);
  cache.set(key, fresh);
  return fresh;
}

export function invalidateEntitlements(orgId) {
  if (!orgId) return;
  cache.del(String(orgId).toLowerCase());
}

/** Bust the whole cache — used when a global setting changes (kill-switch). */
export function invalidateAllEntitlements() {
  cache.flushAll();
}

/** For tests / observability — peek at the cache without warming it. */
export function _peekCache(orgId) {
  return cache.get(String(orgId).toLowerCase()) || null;
}

// ── Internal ─────────────────────────────────────────────────────────

async function computeEntitlements(orgId) {
  const { OrganizationSubscription, SubscriptionPlan, PlanRevision, SubscriptionOverride } = getRouterModels();

  const sub = await OrganizationSubscription.findOne({ organization_id: orgId }).lean();
  const overrideDoc = await SubscriptionOverride.findOne({ tenant_id: orgId }).lean();
  const settings = await loadSettings();

  // Apply override only if it's within its effective window. Outside the
  // window, the tenant gets the plan defaults — but we still surface the
  // override's existence (has_override) so the UI can hint "scheduled" /
  // "expired" states.
  const now = new Date();
  const overrideActive = overrideDoc && isOverrideActiveAt(overrideDoc, now);
  const override = overrideActive ? overrideDoc : null;

  // No subscription yet — return a "noSubscription" shape with empty grants.
  if (!sub) {
    return {
      plan_code: null,
      plan_name: null,
      revision_number: null,
      limits: emptyLimits(),
      feature_flags: {},
      pricing: {},
      support: { channel: 'email', responseSLAHours: 48, uptimeSLAPct: null },
      status: 'no_subscription',
      payment_required: true,
      is_comp: false,
      has_override: !!overrideDoc,
      override_active: !!override,
      override_effective_from: overrideDoc?.effective_from || null,
      override_effective_until: overrideDoc?.effective_until || null,
      overage_kill_switch: !!settings.overagesGloballyDisabled,
      trial_days: settings.defaultTrialDays || 14,
      billing_cycle: null,
      current_period_end: null,
      cancel_at_period_end: false,
      _resolved_at: new Date()
    };
  }

  // Prefer the pinned revision snapshot so price/limit edits don't auto-apply.
  let snapshot = null;
  if (sub.plan_revision_id) {
    const rev = await PlanRevision.findById(sub.plan_revision_id).lean();
    if (rev?.snapshot) snapshot = rev.snapshot;
  }

  // Fallbacks: latest plan doc (legacy subscriptions w/o pin), then template.
  if (!snapshot) {
    const plan = await SubscriptionPlan.findById(sub.plan_id).lean();
    if (plan) snapshot = serializePlan(plan);
  }
  if (!snapshot) {
    // Subscription points at a deleted plan — return defensive defaults.
    snapshot = findTemplateByCode('foundation') || { code: 'unknown', name: 'Unknown', limits: emptyLimits(), feature_flags: {}, pricing: {}, support: {}, trial_days: 0 };
  }

  // Merge override on top of the pinned snapshot. Both `limits` and
  // `pricing` are key-wise: undefined/null means "inherit". Feature flags
  // honour `override.feature_flag_mode`:
  //   'merge'   — per-key override (default; missing = inherit)
  //   'replace' — override IS the complete allowed set; missing = denied
  const limits = mergeLimits(snapshot.limits, override?.limits);
  const featureFlags = mergeFeatureFlags(
    snapshot.feature_flags,
    override?.feature_flags,
    override?.feature_flag_mode || 'merge'
  );
  const pricing = mergePricing(snapshot.pricing, override?.pricing);

  return {
    plan_code: snapshot.code || snapshot.plan_code || null,
    plan_name: snapshot.name || snapshot.plan_name || null,
    revision_number: sub.plan_revision_number || snapshot.current_revision || null,
    limits,
    feature_flags: featureFlags,
    pricing,
    support: snapshot.support || { channel: 'email', responseSLAHours: 48, uptimeSLAPct: null },
    status: sub.status,
    payment_required: derivePaymentRequired(sub),
    is_comp: !!sub.is_comp,
    has_override: !!overrideDoc,
    override_active: !!override,
    override_effective_from: overrideDoc?.effective_from || null,
    override_effective_until: overrideDoc?.effective_until || null,
    overage_kill_switch: !!settings.overagesGloballyDisabled,
    trial_days: snapshot.trial_days ?? 14,
    billing_cycle: sub.billing_cycle,
    current_period_end: sub.current_period_end || null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    _resolved_at: new Date()
  };
}

/**
 * Decide whether a tenant must complete a payment before being granted
 * platform access.
 *
 *   Comped subs       → never require payment (Calcite-granted free access)
 *   Stripe-backed     → trust Stripe state ('past_due' / 'cancelled' /
 *                       'incomplete' all require action via portal)
 *   No Stripe at all  → SuperAdmin manually assigned with no payment;
 *                       require checkout before access is granted
 */
function derivePaymentRequired(sub) {
  if (!sub) return true;
  if (sub.is_comp) return false;
  // Trialing is a paid state — Stripe granted the trial, charge happens
  // at period end. Allow access during trial.
  if (sub.status === 'trialing' && sub.stripe_subscription_id) return false;
  if (sub.status === 'active' && sub.stripe_subscription_id) return false;
  // Anything else (past_due, cancelled, incomplete, or status='active'
  // but no Stripe sub at all = manual SuperAdmin assignment) → must pay.
  return true;
}

function isOverrideActiveAt(override, when) {
  if (!override) return false;
  const from = override.effective_from ? new Date(override.effective_from) : null;
  const until = override.effective_until ? new Date(override.effective_until) : null;
  if (from && when < from) return false;
  if (until && when >= until) return false;
  return true;
}

function emptyLimits() {
  return {
    staffSeats: 0,
    boardSeats: 0,
    workflowsPerMonth: 0,
    storageGB: 0,
    apiCallsPerDay: 0,
    customWorkflows: 0,
    childEntities: 0,
    softCapPct: 80,
    hardCapPct: 100
  };
}

function mergeLimits(planLimits = {}, overrideLimits) {
  const base = { ...emptyLimits(), ...(planLimits || {}) };
  if (!overrideLimits) return base;
  for (const [k, v] of Object.entries(overrideLimits)) {
    if (v === null || v === undefined) continue;
    base[k] = Number(v);
  }
  return base;
}

function mergePricing(planPricing = {}, overridePricing) {
  const base = { ...(planPricing || {}) };
  if (!overridePricing) return base;
  for (const [k, v] of Object.entries(overridePricing)) {
    if (v === null || v === undefined) continue;
    base[k] = Number(v);
  }
  return base;
}

function mergeFeatureFlags(planFlags, overrideFlags, mode = 'merge') {
  const fromPlan = mapToObject(planFlags);
  const fromOverride = mapToObject(overrideFlags);

  if (mode === 'replace' && Object.keys(fromOverride).length > 0) {
    // The override is authoritative — return ONLY the override's flags.
    // Anything not listed is denied. Plan defaults are ignored entirely.
    // Force `false` on every flag the plan knows about so callers that
    // iterate the plan catalogue still see all keys (just denied).
    const result = {};
    for (const code of Object.keys(fromPlan)) result[code] = false;
    for (const [code, value] of Object.entries(fromOverride)) result[code] = !!value;
    return result;
  }
  // Merge mode (default) — override modifies plan per-key.
  return { ...fromPlan, ...fromOverride };
}

function mapToObject(maybeMap) {
  if (!maybeMap) return {};
  if (maybeMap instanceof Map) return Object.fromEntries(maybeMap);
  return { ...maybeMap };
}

function serializePlan(p) {
  return {
    code: p.plan_code,
    name: p.plan_name,
    limits: p.limits,
    feature_flags: p.feature_flags,
    pricing: p.pricing,
    support: p.support,
    trial_days: p.trial_days,
    current_revision: p.current_revision
  };
}

async function loadSettings() {
  // Settings live on a single doc keyed `key='global'` — see opsRoutes.js.
  // Cached lightly via the same NodeCache to avoid round-trips per request.
  const cached = cache.get('__settings__');
  if (cached) return cached;
  try {
    const { getRouterConnection } = await import('../config/database.js');
    const conn = getRouterConnection();
    const doc = await conn.collection('admin_settings').findOne({ key: 'global' });
    const value = {
      overagesGloballyDisabled: !!doc?.overagesGloballyDisabled,
      defaultSoftCapPct: doc?.defaultSoftCapPct ?? 80,
      defaultHardCapPct: doc?.defaultHardCapPct ?? 100,
      defaultTrialDays: doc?.defaultTrialDays ?? 14
    };
    cache.set('__settings__', value, 30); // 30s — tighter than entitlements
    return value;
  } catch {
    return { overagesGloballyDisabled: false, defaultSoftCapPct: 80, defaultHardCapPct: 100, defaultTrialDays: 14 };
  }
}
