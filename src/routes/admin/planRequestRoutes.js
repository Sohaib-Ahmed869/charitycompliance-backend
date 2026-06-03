/**
 * SuperAdmin / support-agent endpoints for triaging bespoke / contact-
 * sales requests submitted from the public pricing page.
 *
 * - GET    /admin/plan-requests        — paginated list with status filter
 * - GET    /admin/plan-requests/:id    — single request detail
 * - PATCH  /admin/plan-requests/:id    — update status / notes / assignee
 *
 * Auth: Calcite staff only (super_admin, support_agent, billing_operator).
 * The mutating PATCH is restricted further to super_admin + support_agent.
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireCalciteStaff } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';

const router = express.Router();

router.use(authenticate);
router.use(requireCalciteStaff);

const VALID_STATUSES = ['new', 'contacted', 'closed'];

/**
 * GET /admin/plan-requests
 *   ?status=new|contacted|closed   (optional; omit for "all")
 *   ?plan=bespoke                  (optional; filter by plan code)
 *   ?limit=50&skip=0               (pagination, defaults 50/0)
 *
 * Returns rows newest first plus `meta.counts` keyed by status so the UI
 * can render a tally strip without a second round-trip.
 */
router.get(
  '/',
  [
    query('status').optional().isIn(VALID_STATUSES),
    query('plan').optional().isString().trim().isLength({ max: 64 }),
    query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { PlanRequest } = getRouterModels();
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.plan) filter.plan_code = String(req.query.plan).toLowerCase();
    const limit = req.query.limit || 50;
    const skip = req.query.skip || 0;

    const [rows, total, counts] = await Promise.all([
      PlanRequest.find(filter).sort({ captured_at: -1 }).skip(skip).limit(limit).lean(),
      PlanRequest.countDocuments(filter),
      PlanRequest.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    ]);

    const countsByStatus = { new: 0, contacted: 0, closed: 0 };
    for (const c of counts) {
      if (c && c._id in countsByStatus) countsByStatus[c._id] = c.n;
    }

    res.json({
      success: true,
      data: rows.map(serializeRequest),
      meta: {
        total,
        limit,
        skip,
        counts: countsByStatus
      }
    });
  })
);

/** GET /admin/plan-requests/:id */
router.get(
  '/:id',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { PlanRequest } = getRouterModels();
    const row = await PlanRequest.findById(req.params.id).lean();
    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_REQUEST_NOT_FOUND', message: 'No such plan request.' }
      });
    }
    res.json({ success: true, data: serializeRequest(row) });
  })
);

/**
 * PATCH /admin/plan-requests/:id
 *   { status?, notes?, assigned_to? }
 *
 * Triage update. All fields optional — caller can flip status without
 * touching notes, or vice versa. Status changes also stamp the
 * appropriate timestamp (`contacted_at` / `closed_at`) for an audit
 * trail.
 */
router.patch(
  '/:id',
  [
    param('id').isMongoId(),
    body('status').optional().isIn(VALID_STATUSES),
    body('notes').optional().isString().isLength({ max: 4000 }),
    body('assigned_to').optional().isString().trim().isLength({ max: 120 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { PlanRequest } = getRouterModels();
    const row = await PlanRequest.findById(req.params.id);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'PLAN_REQUEST_NOT_FOUND', message: 'No such plan request.' }
      });
    }

    if (typeof req.body.status === 'string' && VALID_STATUSES.includes(req.body.status)) {
      row.status = req.body.status;
    }
    if (typeof req.body.notes === 'string') row.notes = req.body.notes;
    if (typeof req.body.assigned_to === 'string') row.assigned_to = req.body.assigned_to;

    await row.save();
    res.json({ success: true, data: serializeRequest(row.toObject()) });
  })
);

function serializeRequest(r) {
  if (!r) return null;
  return {
    id: String(r._id),
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    organization_name: r.organization_name || '',
    plan_code: r.plan_code || '',
    plan_name: r.plan_name || '',
    message: r.message || '',
    status: r.status || 'new',
    notes: r.notes || '',
    assigned_to: r.assigned_to || '',
    owner_email_sent_at: r.owner_email_sent_at || null,
    ack_email_sent_at: r.ack_email_sent_at || null,
    email_send_error: r.email_send_error || '',
    source_url: r.source_url || '',
    existing_org_id: r.existing_org_id || '',
    captured_at: r.captured_at || r.createdAt || null,
    created_at: r.createdAt || null,
    updated_at: r.updatedAt || null
  };
}

export default router;
