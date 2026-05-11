/**
 * Two-person approval helpers (handbook §7.3, architecture §1, §2.4).
 *
 * The dangerous super-admin actions — raising a price, reducing a quota,
 * removing a feature from a plan, archiving a plan, deprecating a feature
 * flag — must be approved by a SECOND super-admin before they propagate
 * to Stripe and to live tenants.
 *
 * The flow:
 *   1. Operator submits the change.
 *   2. The endpoint computes a diff against the current state and calls
 *      `detectDangerousPlanDiff` (or `detectFlagDeprecation`). If anything
 *      flagged comes back, the endpoint writes a BillingEvent with
 *      `status='pending_approval'`, stores the proposed payload in
 *      `pending_payload`, and returns 202 Accepted instead of executing.
 *   3. A different super-admin opens /admin/approvals, reviews the diff,
 *      and clicks Approve (or Reject, with reason).
 *   4. Approve replays the original action by dispatching on the
 *      pending event's action code; the original BillingEvent is also
 *      written for the actual execution, so audit shows both rows.
 *
 * The "different super-admin" rule is enforced server-side: a requester
 * cannot approve their own request, even if they're the only super-admin
 * online (they have to escalate).
 */

import getRouterModels from '../db/models/routerModels.js';
import { logError } from './logger.js';

// ─── Diff detectors ──────────────────────────────────────────────────

/**
 * Compare two plan snapshots (as returned by serializePlan) and report
 * which dangerous changes the proposed update would introduce.
 *
 * @returns {string[]}  e.g. ['price_raised', 'quota_reduced', 'feature_removed']
 */
export function detectDangerousPlanDiff(prevSnapshot, nextSnapshot) {
  if (!prevSnapshot) return []; // first-time materialisation is not a price change
  const dangers = new Set();

  // Price raised — any pricing field that went up.
  const prevPricing = prevSnapshot.pricing || {};
  const nextPricing = nextSnapshot.pricing || {};
  for (const key of Object.keys(nextPricing)) {
    const before = Number(prevPricing[key] ?? 0);
    const after  = Number(nextPricing[key] ?? 0);
    if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
      dangers.add('price_raised');
      break;
    }
  }

  // Quota reduced — any limit that went down.
  const prevLimits = prevSnapshot.limits || {};
  const nextLimits = nextSnapshot.limits || {};
  for (const key of Object.keys(nextLimits)) {
    const before = prevLimits[key];
    const after  = nextLimits[key];
    // -1 / null are conventionally "unlimited" — treat going from
    // unlimited (-1) to any finite number as a reduction.
    const beforeNum = before === null || before === undefined ? Infinity : (Number(before) === -1 ? Infinity : Number(before));
    const afterNum  = after  === null || after  === undefined ? Infinity : (Number(after)  === -1 ? Infinity : Number(after));
    if (Number.isFinite(afterNum) && afterNum < beforeNum) {
      dangers.add('quota_reduced');
      break;
    }
  }

  // Feature removed — any flag that went from `true` to `false`.
  const prevFlags = prevSnapshot.feature_flags || {};
  const nextFlags = nextSnapshot.feature_flags || {};
  for (const key of Object.keys(prevFlags)) {
    if (prevFlags[key] === true && nextFlags[key] === false) {
      dangers.add('feature_removed');
      break;
    }
  }

  // Status flipped to archived from a non-archived state.
  if (prevSnapshot.status !== 'archived' && nextSnapshot.status === 'archived') {
    dangers.add('plan_archive');
  }

  return Array.from(dangers);
}

// ─── Pending-event helpers ───────────────────────────────────────────

/**
 * Write a BillingEvent in `pending_approval` state.
 * @returns {Promise<{ _id, status: 'pending_approval' }>}
 */
export async function createPendingApproval(req, {
  action,
  targetType,
  targetId,
  targetLabel = '',
  tenantId = '',
  reason = '',
  diff = [],
  pendingPayload,
  pendingDangers = []
}) {
  const { BillingEvent } = getRouterModels();
  const evt = await BillingEvent.create({
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    target_label: targetLabel,
    tenant_id: tenantId,
    actor_id: req?.user?.userId || null,
    actor_email: req?.user?.email || '',
    diff,
    reason,
    metadata: {},
    status: 'pending_approval',
    pending_payload: pendingPayload,
    pending_dangers: pendingDangers
  });
  return evt;
}

/**
 * Look up a pending event for approve / reject. Throws an AppError-shaped
 * `{ statusCode, code, message }` when the row is missing, already
 * resolved, or being approved by its own requester.
 */
export async function loadPending(eventId, { approverId } = {}) {
  const { BillingEvent } = getRouterModels();
  const evt = await BillingEvent.findById(eventId);
  if (!evt) {
    throw Object.assign(new Error('Approval not found.'), { statusCode: 404, code: 'APPROVAL_NOT_FOUND' });
  }
  if (evt.status !== 'pending_approval') {
    throw Object.assign(new Error('This request has already been resolved.'), {
      statusCode: 409,
      code: 'APPROVAL_ALREADY_RESOLVED'
    });
  }
  if (approverId && String(evt.actor_id) === String(approverId)) {
    throw Object.assign(new Error('A second super-admin must approve — you cannot approve your own request.'), {
      statusCode: 403,
      code: 'APPROVAL_SELF_FORBIDDEN'
    });
  }
  return evt;
}

/** Mark a pending event as executed — call AFTER the proposed change has been applied. */
export async function markApproved(evt, req) {
  evt.status = 'executed';
  evt.approved_by = req?.user?.userId || null;
  evt.approved_by_email = req?.user?.email || '';
  evt.approved_at = new Date();
  await evt.save().catch((err) => logError('markApproved save', err, { id: evt._id }));
  return evt;
}

/** Mark a pending event as rejected (no execution). */
export async function markRejected(evt, req, rejectionReason = '') {
  evt.status = 'rejected';
  evt.rejected_by = req?.user?.userId || null;
  evt.rejected_by_email = req?.user?.email || '';
  evt.rejected_at = new Date();
  evt.rejection_reason = rejectionReason || '';
  await evt.save().catch((err) => logError('markRejected save', err, { id: evt._id }));
  return evt;
}
