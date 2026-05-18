/**
 * Public, UNAUTHENTICATED plan catalogue for the marketing /pricing page.
 *
 * Mirrors /platform/billing/available-plans without the tenant context,
 * current-subscription injection, or auth middleware. Only fields a
 * logged-out visitor needs are surfaced (name, pricing, limits, support,
 * trial_days, metadata). Returns plans merged with in-code defaults so
 * the marketing page works on a fresh deployment with no DB rows yet.
 */

import express from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { mergePlansWithTemplates } from '../../utils/defaultPlans.js';

const router = express.Router();

router.get('/', asyncHandler(async (_req, res) => {
  const { SubscriptionPlan } = getRouterModels();

  const dbPlans = await SubscriptionPlan
    .find({ visibility: 'public', status: 'active' })
    .sort({ 'metadata.sortOrder': 1, plan_code: 1 })
    .lean();

  const merged = mergePlansWithTemplates(dbPlans.map((p) => ({
    _id: p._id,
    code: p.plan_code,
    name: p.plan_name,
    visibility: p.visibility || 'public',
    status: p.status || 'active',
    pricing: p.pricing || {},
    limits: p.limits || {},
    feature_flags: p.feature_flags instanceof Map
      ? Object.fromEntries(p.feature_flags)
      : (p.feature_flags || {}),
    support: p.support || {},
    trial_days: p.trial_days ?? 14,
    metadata: p.metadata || {},
    current_revision: p.current_revision ?? 1
  })));

  // Strip non-marketing data — no Stripe IDs, no revision number, no
  // internal hooks. Only what the public pricing page needs to render.
  const visible = merged
    .filter((p) => p.status !== 'archived' && p.visibility === 'public')
    .map((p) => ({
      code: p.code,
      name: p.name,
      pricing: {
        monthlyAUD: Number(p.pricing?.monthlyAUD) || 0,
        annualAUD: Number(p.pricing?.annualAUD) || 0,
        currency: p.pricing?.currency || 'AUD'
      },
      limits: {
        staffSeats: p.limits?.staffSeats ?? 0,
        boardSeats: p.limits?.boardSeats ?? 0,
        workflowsPerMonth: p.limits?.workflowsPerMonth ?? 0,
        storageGB: p.limits?.storageGB ?? 0,
        apiCallsPerDay: p.limits?.apiCallsPerDay ?? 0
      },
      support: {
        channel: p.support?.channel || 'email',
        responseSLAHours: p.support?.responseSLAHours ?? 48,
        uptimeSLAPct: p.support?.uptimeSLAPct ?? null
      },
      trial_days: p.trial_days ?? 14,
      metadata: {
        description: p.metadata?.description || '',
        targetCustomer: p.metadata?.targetCustomer || '',
        sortOrder: p.metadata?.sortOrder ?? 100
      }
    }));

  res.json({ success: true, data: visible });
}));

export default router;
