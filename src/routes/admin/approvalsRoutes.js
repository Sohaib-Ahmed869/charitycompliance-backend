/**
 * Two-person approvals — list pending requests, approve, reject.
 *
 * A pending BillingEvent (status='pending_approval') was created by some
 * other endpoint (Plan PATCH, Plan archive, Flag deprecation, etc.) when
 * its diff detector flagged a dangerous change. The proposed payload is
 * stashed on the event; this router replays it on Approve, or marks it
 * rejected on Reject — never executing without a second super-admin.
 *
 * Strict super-admin only. The `loadPending` helper enforces "you cannot
 * approve your own request" server-side; the UI mirrors it but the server
 * is the gate.
 */

import express from 'express';
import { body, param } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import {
  loadPending,
  markApproved,
  markRejected,
  countActiveSuperAdmins
} from '../../utils/twoPersonApproval.js';
import { applyPlanPatch, applyPlanArchive } from './planRoutes.js';

const router = express.Router();
router.use(authenticate);

function serialize(evt, staffById = {}) {
  const requester = staffById[String(evt.actor_id || '')] || null;
  return {
    _id: evt._id,
    action: evt.action,
    target_type: evt.target_type,
    target_id: evt.target_id,
    target_label: evt.target_label,
    tenant_id: evt.tenant_id,
    requested_by_id: evt.actor_id,
    requested_by_email: evt.actor_email,
    requested_by_name: requester?.full_name || '',
    requested_by_role: requester?.role || '',
    diff: evt.diff || [],
    reason: evt.reason || '',
    pending_dangers: evt.pending_dangers || [],
    pending_payload: evt.pending_payload || null,
    status: evt.status,
    approved_by: evt.approved_by,
    approved_by_email: evt.approved_by_email,
    approved_at: evt.approved_at,
    rejected_by: evt.rejected_by,
    rejected_by_email: evt.rejected_by_email,
    rejected_at: evt.rejected_at,
    rejection_reason: evt.rejection_reason,
    created_at: evt.created_at
  };
}

/** GET /admin/approvals — list pending two-person-rule requests. */
router.get('/approvals', requireSuperAdmin, asyncHandler(async (_req, res) => {
  const { BillingEvent, SuperAdmin } = getRouterModels();
  const events = await BillingEvent
    .find({ status: 'pending_approval' })
    .sort({ created_at: -1 })
    .limit(100)
    .lean();

  // Bulk-resolve requester identities so each row can show
  // "Full Name (role) — email" instead of just an email.
  const actorIds = [...new Set(events.map((e) => String(e.actor_id || '')).filter(Boolean))];
  const staff = actorIds.length
    ? await SuperAdmin.find({ _id: { $in: actorIds } }).select('full_name role email').lean()
    : [];
  const staffById = Object.fromEntries(staff.map((s) => [String(s._id), s]));

  const activeSuperAdmins = await countActiveSuperAdmins();

  res.json({
    success: true,
    data: events.map((evt) => serialize(evt, staffById)),
    meta: {
      active_super_admin_count: activeSuperAdmins,
      two_person_rule_active: activeSuperAdmins >= 2
    }
  });
}));

/**
 * POST /admin/approvals/:eventId/approve
 *
 * Replays the proposed change against the original endpoint logic. The
 * pending event is marked executed; a fresh BillingEvent is also written
 * by the underlying applyXxx() helper so the audit screen shows BOTH the
 * approval row and the actual execution row.
 */
router.post(
  '/approvals/:eventId/approve',
  requireSuperAdmin,
  [param('eventId').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    let evt;
    let soloSelfApproval = false;
    try {
      const loaded = await loadPending(req.params.eventId, { approverId: req.user?.userId });
      evt = loaded.evt;
      soloSelfApproval = loaded.soloSelfApproval;
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: { code: err.code || 'APPROVAL_FAILED', message: err.message }
      });
    }

    const payload = evt.pending_payload || {};
    let result;

    switch (evt.action) {
      case 'plan.update_pending': {
        // Replay the patch with the approval bypass flag so the gate
        // doesn't re-trigger on the second pass.
        const replayBody = { ...(payload.body || {}), __approvedReplay: true };
        result = await applyPlanPatch({
          req,
          code: String(payload.code || '').toLowerCase(),
          patch: replayBody,
          reason: replayBody.reason || evt.reason || ''
        });
        break;
      }
      case 'plan.archive_pending': {
        result = await applyPlanArchive({
          req,
          code: String(payload.code || '').toLowerCase(),
          reason: payload.reason || evt.reason || 'Archived.'
        });
        break;
      }
      default:
        return res.status(400).json({
          success: false,
          error: { code: 'UNKNOWN_PENDING_ACTION', message: `Cannot replay action "${evt.action}".` }
        });
    }

    if (result.error) {
      // Apply failed — leave the event pending so it can be retried or
      // rejected. Surface the underlying error.
      return res.status(result.statusCode || 500).json({
        success: false,
        error: result.error
      });
    }

    await markApproved(evt, req, { soloSelfApproved: soloSelfApproval });
    return res.json({
      success: true,
      data: {
        approved_event_id: evt._id,
        applied: result.data,
        solo_self_approved: soloSelfApproval
      }
    });
  })
);

/** POST /admin/approvals/:eventId/reject — close out a pending event. */
router.post(
  '/approvals/:eventId/reject',
  requireSuperAdmin,
  [
    param('eventId').isMongoId(),
    body('reason').optional().isString().trim().isLength({ max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    let evt;
    try {
      const loaded = await loadPending(req.params.eventId, { approverId: null });
      evt = loaded.evt;
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: { code: err.code || 'APPROVAL_FAILED', message: err.message }
      });
    }
    await markRejected(evt, req, req.body?.reason || '');
    return res.json({ success: true, data: serialize(evt) });
  })
);

export default router;
