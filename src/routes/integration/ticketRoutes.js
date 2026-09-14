/**
 * Integration API — Support tickets.
 *
 * Tickets live in each tenant's own database, so every write is addressed
 * as /tenants/:orgId/tickets/…  GET /tickets fans out across all active
 * tenants for a single support-desk view.
 *
 * Tickets raised here are recorded as external reports (reporter_name /
 * reporter_email) because an API caller is not a tenant user.
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { lookupTenant } from '../../db/router.js';
import { getTenantConnection } from '../../db/connectionManager.js';
import { UserRepository } from '../../repositories/userRepository.js';
import { SupportTicketService } from '../../services/supportTicketService.js';
import { logError } from '../../utils/logger.js';

const router = express.Router();

const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['new', 'in_progress', 'solved', 'declined', 'on_hold'];
const CATEGORIES = ['technical_error', 'bug_report', 'feature_request', 'access_issue', 'data_issue', 'general', 'other',
  'technical', 'billing', 'account', 'feedback'];
const MODULES = ['IT Systems Register', 'Risk Register', 'Policy Register', 'Financial Management', 'Human Resources',
  'Meetings & Calendar', 'Compliance', 'Asset Register', 'Grants & Donors', 'Board & Governance', 'BCP', 'Expenses', 'Other'];

const ticketId = param('ticketId').isMongoId().withMessage('Invalid ticket ID');
const listFilters = [
  query('status').optional().isIn(STATUSES),
  query('priority').optional().isIn(PRIORITIES),
  query('category').optional().isIn(CATEGORIES)
];

/** Resolve :orgId to an ACTIVE tenant (404 otherwise) and attach a ticket service. */
const withTenant = [
  param('orgId').isString().trim().notEmpty(),
  validate,
  asyncHandler(async (req, res, next) => {
    const orgId = String(req.params.orgId).toLowerCase().trim();
    try {
      await lookupTenant(orgId);
    } catch {
      return res.status(404).json({
        success: false,
        error: { code: 'TENANT_NOT_FOUND', message: 'No such active tenant.' }
      });
    }
    req.orgId = orgId;
    req.tickets = await ticketServiceFor(orgId);
    next();
  })
];

/**
 * Ticket queries populate reporter/assignee/comment users, which needs the
 * User model registered on the tenant connection. JWT requests get that as a
 * side effect of `authenticate`; API-key requests don't, so do it here.
 */
async function ticketServiceFor(orgId) {
  new UserRepository(await getTenantConnection(orgId));
  return new SupportTicketService(orgId);
}

const filtersFrom = (q) => ({ status: q.status, priority: q.priority, category: q.category, assignee: q.assignee });

/** GET /tickets?orgId=&status=&priority=&category= — tickets across every active tenant, newest first. */
router.get(
  '/tickets',
  [query('orgId').optional().isString().trim(), ...listFilters],
  validate,
  asyncHandler(async (req, res) => {
    const { Tenant } = getRouterModels();
    const filter = { status: 'active' };
    if (req.query.orgId) filter.orgId = String(req.query.orgId).toLowerCase();
    const tenants = await Tenant.find(filter).select('orgId').lean();

    const failed = [];
    const perTenant = await Promise.all(tenants.map(async ({ orgId }) => {
      try {
        const tickets = await (await ticketServiceFor(orgId)).getTickets(filtersFrom(req.query));
        return tickets.map((t) => ({ ...t, org_id: orgId }));
      } catch (err) {
        logError('Integration ticket fan-out failed for tenant', err, { orgId });
        failed.push(orgId);
        return [];
      }
    }));

    const data = perTenant.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, data, meta: { tenants: tenants.length, failed_tenants: failed } });
  })
);

/** GET /tenants/:orgId/tickets — one tenant's tickets. */
router.get(
  '/tenants/:orgId/tickets',
  withTenant,
  listFilters,
  validate,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await req.tickets.getTickets(filtersFrom(req.query)) });
  })
);

/** GET /tenants/:orgId/tickets/stats — counts by status/priority for the tenant. */
router.get(
  '/tenants/:orgId/tickets/stats',
  withTenant,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await req.tickets.getStats() });
  })
);

/** GET /tenants/:orgId/tickets/:ticketId */
router.get(
  '/tenants/:orgId/tickets/:ticketId',
  withTenant,
  [ticketId],
  validate,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await req.tickets.getTicketById(req.params.ticketId) });
  })
);

/** POST /tenants/:orgId/tickets — { summary, reporter_name, reporter_email, description?, priority?, category?, module? } */
router.post(
  '/tenants/:orgId/tickets',
  withTenant,
  [
    body('summary').isString().trim().notEmpty().withMessage('summary is required'),
    body('reporter_name').isString().trim().notEmpty().withMessage('reporter_name is required'),
    body('reporter_email').isEmail().withMessage('Valid reporter_email is required'),
    body('description').optional().isString().trim(),
    body('priority').optional().isIn(PRIORITIES),
    body('category').optional().isIn(CATEGORIES),
    body('module').optional().isIn(MODULES)
  ],
  validate,
  asyncHandler(async (req, res) => {
    const created = await req.tickets.createTicket({
      summary: req.body.summary,
      description: req.body.description,
      priority: req.body.priority,
      category: req.body.category,
      module: req.body.module,
      reporter_name: req.body.reporter_name,
      reporter_email: req.body.reporter_email
    }, null);
    res.status(201).json({ success: true, data: await req.tickets.getTicketById(created._id) });
  })
);

/** PUT /tenants/:orgId/tickets/:ticketId — edit summary/description/priority/category/module. */
router.put(
  '/tenants/:orgId/tickets/:ticketId',
  withTenant,
  [
    ticketId,
    body('summary').optional().isString().trim().notEmpty(),
    body('description').optional().isString().trim(),
    body('priority').optional().isIn(PRIORITIES),
    body('category').optional().isIn(CATEGORIES),
    body('module').optional().isIn(MODULES)
  ],
  validate,
  asyncHandler(async (req, res) => {
    const update = {};
    for (const k of ['summary', 'description', 'priority', 'category', 'module']) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NOTHING_TO_UPDATE', message: 'Provide at least one of summary, description, priority, category, module.' }
      });
    }
    res.json({ success: true, data: await req.tickets.updateTicket(req.params.ticketId, update) });
  })
);

/** PATCH /tenants/:orgId/tickets/:ticketId/status — { status, resolution_notes? } */
router.patch(
  '/tenants/:orgId/tickets/:ticketId/status',
  withTenant,
  [
    ticketId,
    body('status').isIn(STATUSES).withMessage(`status must be one of ${STATUSES.join(', ')}`),
    body('resolution_notes').optional().isString().trim()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const data = await req.tickets.updateStatus(req.params.ticketId, req.body.status, null, req.body.resolution_notes);
    res.json({ success: true, data });
  })
);

/** POST /tenants/:orgId/tickets/:ticketId/assign — { assignee_id } (a user id in that tenant). */
router.post(
  '/tenants/:orgId/tickets/:ticketId/assign',
  withTenant,
  [ticketId, body('assignee_id').isMongoId().withMessage('Valid assignee_id is required')],
  validate,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await req.tickets.assignTicket(req.params.ticketId, req.body.assignee_id) });
  })
);

/** POST /tenants/:orgId/tickets/:ticketId/comments — { message, is_internal?, author_name? } */
router.post(
  '/tenants/:orgId/tickets/:ticketId/comments',
  withTenant,
  [
    ticketId,
    body('message').isString().trim().notEmpty().withMessage('message is required'),
    body('is_internal').optional().isBoolean(),
    body('author_name').optional().isString().trim().isLength({ max: 120 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const author = req.body.author_name || 'Calcite Support';
    const data = await req.tickets.addComment(req.params.ticketId, req.body.message, null, req.body.is_internal === true, author);
    res.json({ success: true, data });
  })
);

/** DELETE /tenants/:orgId/tickets/:ticketId */
router.delete(
  '/tenants/:orgId/tickets/:ticketId',
  withTenant,
  [ticketId],
  validate,
  asyncHandler(async (req, res) => {
    await req.tickets.deleteTicket(req.params.ticketId);
    res.json({ success: true, data: { deleted: true } });
  })
);

export default router;
