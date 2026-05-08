/**
 * Override validation — refuses any override that would set a cap BELOW
 * the tenant's current actual usage. Prevents nonsense states like "you
 * have 10 staff seats but I just capped you at 5".
 *
 * Returns { valid, conflicts } — caller (PUT override) responds with 422
 * if invalid, naming each metric and showing current/attempted values.
 */

import { getUsageSummary } from './usageMeterService.js';
import { getTenantConnection } from '../db/connectionManager.js';

const LIMIT_TO_USAGE_KEY = {
  staffSeats: 'staffSeatsActive',
  boardSeats: 'boardSeatsActive',
  workflowsPerMonth: 'workflowsThisPeriod',
  storageGB: 'storageGBUsed'
  // apiCallsPerDay / customWorkflows / childEntities — no live counter yet,
  // so they cannot cause a conflict and are accepted at face value.
};

const FRIENDLY_LABEL = {
  staffSeats: 'staff seats',
  boardSeats: 'board seats',
  workflowsPerMonth: 'workflows this month',
  storageGB: 'storage (GB)'
};

/**
 * @param {string} orgId
 * @param {object} proposedOverride - the override body (limits/feature_flags/pricing/etc.)
 * @returns {Promise<{valid: boolean, conflicts: Array<{field, current, attempted, message}>}>}
 */
export async function validateOverride(orgId, proposedOverride) {
  const conflicts = [];
  const proposedLimits = proposedOverride?.limits || {};

  // Nothing to validate.
  if (!Object.keys(proposedLimits).length) {
    return { valid: true, conflicts: [] };
  }

  // Read live usage off the tenant DB.
  let usage = {};
  try {
    const tenantDb = await getTenantConnection(orgId);
    usage = await getUsageSummary({ tenantDb, orgId });
  } catch (err) {
    // If we can't reach the tenant DB, skip live checks rather than blocking
    // the override save outright. Better to accept and audit.
    console.warn('[validateOverride] usage read failed for', orgId, err?.message || err);
    return { valid: true, conflicts: [] };
  }

  for (const [field, attempted] of Object.entries(proposedLimits)) {
    if (attempted === null || attempted === undefined || attempted === '') continue;
    const num = Number(attempted);
    if (Number.isNaN(num)) continue;
    if (num === -1) continue; // Unlimited never conflicts.

    const usageKey = LIMIT_TO_USAGE_KEY[field];
    if (!usageKey) continue;
    const current = Number(usage[usageKey] ?? 0);
    if (current > num) {
      const label = FRIENDLY_LABEL[field] || field;
      conflicts.push({
        field,
        current,
        attempted: num,
        message: `Tenant currently uses ${current} ${label} — cannot set cap to ${num}.`
      });
    }
  }

  return { valid: conflicts.length === 0, conflicts };
}
