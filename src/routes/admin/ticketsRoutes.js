/**
 * SuperAdmin / Support-Agent — cross-tenant ticket triage.
 *
 * Tenants store their tickets in their own DB. To give Calcite staff a
 * single inbox we iterate every Tenant row and aggregate. Performance is
 * fine for current scale; if it becomes a problem, mirror tickets to a
 * Router-DB index on create/update.
 *
 * Endpoints:
 *   GET   /admin/tickets                 — list across every tenant
 *   GET   /admin/tickets/board           — kanban grouped by triage + kanban_status
 *   PATCH /admin/tickets/:tenantId/:id   — set triage / kanban_status / notes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSupportStaff } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { getTenantConnection } from '../../db/connectionManager.js';
import supportTicketSchema from '../../db/schemas/platform/supportTicketSchema.js';
import organizationSchema from '../../db/schemas/platform/organizationSchema.js';

const router = express.Router();
router.use(authenticate);
// requireSupportStaff is applied per-route below — see staffRoutes.js for
// the same fix and the rationale: all admin sub-routers share the
// /api/v1/admin mount, so a router-level guard would 403 unrelated calls
// (e.g. a billing_operator hitting /admin/coupons would be denied here
// before reaching the right router).

function ticketModelFor(tenantDb) {
  return tenantDb.models.SupportTicket || tenantDb.model('SupportTicket', supportTicketSchema);
}

function organizationModelFor(tenantDb) {
  return tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
}

/**
 * Fetch the organisation's display name from the tenant's own DB.
 * Returns null when the org doc is missing or the lookup fails — the
 * frontend then falls back to the orgId so we never render a blank
 * tenant column.
 */
async function getOrgDisplayName(tenantDb) {
  try {
    const Org = organizationModelFor(tenantDb);
    const org = await Org.findOne({}).select('name trading_name').lean();
    return org?.name || org?.trading_name || null;
  } catch {
    return null;
  }
}

function serializeTicket(t, orgId, tenantName) {
  return {
    _id: t._id,
    tenant_id: orgId,
    tenant_name: tenantName || null,
    ticket_number: t.ticket_number,
    summary: t.summary,
    description: t.description,
    priority: t.priority,
    status: t.status,
    category: t.category,
    module: t.module,
    triage: t.triage || 'unclassified',
    kanban_status: t.kanban_status || 'todo',
    triage_notes: t.triage_notes || '',
    triaged_at: t.triaged_at,
    reporter: t.reporter,
    assignee: t.assignee,
    created_at: t.created_at || t.createdAt,
    updated_at: t.updated_at || t.updatedAt
  };
}

/** Aggregate tickets across every tenant, optionally filtered. */
async function aggregateTickets({ filter = {} } = {}) {
  const { Tenant } = getRouterModels();
  const tenants = await Tenant.find({ status: { $ne: 'archived' } }).select('orgId dbName status').lean();

  const all = [];
  for (const t of tenants) {
    try {
      const tenantDb = await getTenantConnection(String(t.orgId).toLowerCase());
      const Ticket = ticketModelFor(tenantDb);
      const [docs, orgName] = await Promise.all([
        Ticket.find(filter).sort({ created_at: -1 }).limit(500).lean(),
        getOrgDisplayName(tenantDb)
      ]);
      for (const d of docs) all.push(serializeTicket(d, t.orgId, orgName));
    } catch (err) {
      // One tenant's DB hiccup shouldn't kill the whole list.
      console.error('[admin/tickets] tenant', t.orgId, 'failed:', err?.message || err);
    }
  }
  // Newest first overall.
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all;
}

/**
 * GET /admin/tickets
 *   ?tenant=<orgId>
 *   ?triage=unclassified|bug|feature|invalid|duplicate
 *   ?kanban=todo|in_progress|done
 *   ?priority=low|medium|high|critical
 *   ?status=new|in_progress|solved|declined|on_hold
 *   ?limit=200
 */
router.get(
  '/tickets',
  requireSupportStaff,
  [
    query('tenant').optional().isString().trim(),
    query('triage').optional().isIn(['unclassified', 'bug', 'feature', 'invalid', 'duplicate']),
    query('kanban').optional().isIn(['todo', 'in_progress', 'done']),
    query('priority').optional().isIn(['low', 'medium', 'high', 'critical']),
    query('status').optional().isIn(['new', 'in_progress', 'solved', 'declined', 'on_hold']),
    query('limit').optional().isInt({ min: 1, max: 500 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.triage) filter.triage = req.query.triage;
    if (req.query.kanban) filter.kanban_status = req.query.kanban;
    if (req.query.priority) filter.priority = req.query.priority;
    if (req.query.status) filter.status = req.query.status;

    if (req.query.tenant) {
      // Single-tenant fast path.
      try {
        const tenantDb = await getTenantConnection(String(req.query.tenant).toLowerCase());
        const Ticket = ticketModelFor(tenantDb);
        const [docs, orgName] = await Promise.all([
          Ticket.find(filter).sort({ created_at: -1 }).limit(500).lean(),
          getOrgDisplayName(tenantDb)
        ]);
        return res.json({ success: true, data: docs.map((d) => serializeTicket(d, req.query.tenant, orgName)) });
      } catch (err) {
        return res.status(404).json({
          success: false,
          error: { code: 'TENANT_NOT_FOUND', message: err?.message || 'No such tenant.' }
        });
      }
    }
    const all = await aggregateTickets({ filter });
    res.json({ success: true, data: all });
  })
);

/**
 * GET /admin/tickets/board
 * Returns tickets grouped for the kanban UI:
 *   { bug: { todo: [], in_progress: [], done: [] },
 *     feature: { todo, in_progress, done } }
 * Excludes invalid/duplicate (those don't belong on a board).
 */
router.get('/tickets/board', requireSupportStaff, asyncHandler(async (_req, res) => {
  const all = await aggregateTickets({ filter: { triage: { $in: ['bug', 'feature'] } } });
  const empty = () => ({ todo: [], in_progress: [], done: [] });
  const board = { bug: empty(), feature: empty() };
  for (const t of all) {
    const kind = t.triage === 'bug' ? 'bug' : 'feature';
    const col = ['todo', 'in_progress', 'done'].includes(t.kanban_status) ? t.kanban_status : 'todo';
    board[kind][col].push(t);
  }
  res.json({ success: true, data: board });
}));

/**
 * PATCH /admin/tickets/:tenantId/:ticketId
 *   body: { triage?, kanban_status?, triage_notes? }
 */
router.patch(
  '/tickets/:tenantId/:ticketId',
  requireSupportStaff,
  [
    param('tenantId').isString().trim().notEmpty(),
    param('ticketId').isMongoId(),
    body('triage').optional().isIn(['unclassified', 'bug', 'feature', 'invalid', 'duplicate']),
    body('kanban_status').optional().isIn(['todo', 'in_progress', 'done']),
    body('triage_notes').optional().isString().trim().isLength({ max: 2000 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const tenantDb = await getTenantConnection(String(req.params.tenantId).toLowerCase());
    const Ticket = ticketModelFor(tenantDb);
    const ticket = await Ticket.findById(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ success: false, error: { code: 'TICKET_NOT_FOUND', message: 'No such ticket.' } });
    }
    if (req.body.triage !== undefined) ticket.triage = req.body.triage;
    if (req.body.kanban_status !== undefined) ticket.kanban_status = req.body.kanban_status;
    if (req.body.triage_notes !== undefined) ticket.triage_notes = req.body.triage_notes;
    ticket.triaged_by = req.user?.userId || null;
    ticket.triaged_at = new Date();
    await ticket.save();
    res.json({ success: true, data: serializeTicket(ticket.toObject(), req.params.tenantId) });
  })
);

export default router;
