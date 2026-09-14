/**
 * Audit Logger Middleware
 *
 * Mounted once on the whole /platform namespace. For every SUCCESSFUL
 * mutating request (POST/PUT/PATCH/DELETE) it writes one append-only
 * audit_logs row capturing who did what, to which record, with the
 * submitted (redacted) values. Because it sits at a single choke point it
 * covers every module automatically — no per-controller wiring needed.
 *
 * It registers a `res.on('finish')` hook and returns immediately, so by the
 * time the hook runs the per-route auth/tenant middleware has populated
 * req.user / req.tenantDb / req.orgId.
 */
import { recordAuditLog, summarizeBody } from '../services/auditLogService.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const isId = (s) => OBJECT_ID_RE.test(s) || /^\d+$/.test(s);

// Map URL segments to the canonical module keys the audit-trail UI knows
// about (MODULE_MAP / MODULE_GROUPS) so entries label + group sensibly.
// Anything not listed falls back to the raw segment (Title-Cased in the UI).
const MODULE_NORMALIZE = {
  expenses: 'finance', 'sweep-funds': 'finance', 'donation-boxes': 'finance', 'financial-controls': 'finance',
  'approval-thresholds': 'financial_thresholds',
  'board-members': 'responsible_people', volunteers: 'responsible_people',
  'disciplinary-records': 'hr',
  'legal-documents': 'legal_document',
  policies: 'policy', marketplace: 'policy',
  risks: 'risk', complaints: 'complaint', approvals: 'approval_workflow',
  donors: 'donor', donations: 'donor', 'donation-milestones': 'donor',
  'funding-agreements': 'funding_agreement', 'funding-programs': 'funding_agreement',
  'project-register': 'project', 'project-delivery': 'project',
  assets: 'asset', 'it-register': 'asset',
  users: 'users', roles: 'users', 'support-tickets': 'support_ticket'
};

const humanize = (s) =>
  String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const singularize = (s) =>
  s.endsWith('ies') ? `${s.slice(0, -3)}y` : (s.endsWith('s') ? s.slice(0, -1) : s);

/** Derive a human action label, module, entity id and clean path from the URL. */
function derive(method, originalUrl) {
  const rawPath = String(originalUrl || '').split('?')[0];
  const marker = '/platform/';
  const i = rawPath.indexOf(marker);
  const tail = i >= 0 ? rawPath.slice(i + marker.length) : rawPath.replace(/^\/+/, '');
  const segments = tail.split('/').filter(Boolean);
  const moduleSeg = segments[0] || 'platform';

  let entityId = null;
  for (let k = segments.length - 1; k >= 1; k -= 1) {
    if (isId(segments[k])) { entityId = segments[k]; break; }
  }
  let actionSeg = null;
  for (let k = segments.length - 1; k >= 1; k -= 1) {
    if (!isId(segments[k])) { actionSeg = segments[k]; break; }
  }

  const verb = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[method] || method;
  const moduleLabel = singularize(humanize(moduleSeg));

  // Friendly labels for well-known sub-actions so the trail reads naturally.
  const FRIENDLY = { logout: 'User logged out', login: 'User logged in', submit: `Submitted ${moduleLabel.toLowerCase()}` };

  let action;
  if (actionSeg && FRIENDLY[actionSeg.toLowerCase()]) {
    action = FRIENDLY[actionSeg.toLowerCase()];
  } else if (actionSeg) {
    action = `${humanize(moduleSeg)}: ${humanize(actionSeg)}`;       // sub-action, e.g. "Expenses: approve"
  } else {
    action = `${verb} ${moduleLabel.toLowerCase()}`;                  // plain CRUD, e.g. "Updated expense"
  }

  const moduleOut = actionSeg === 'logout' || actionSeg === 'login'
    ? 'auth'
    : (MODULE_NORMALIZE[moduleSeg] || moduleSeg);
  return { module: moduleOut, entity_id: entityId, action, path: tail };
}

export function auditLogMutationMiddleware(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) return;        // log successful mutations only (failures are noise / handled elsewhere)
      if (!req.tenantDb || !req.user) return;   // need a tenant + an authenticated actor
      const d = derive(req.method, req.originalUrl || req.url);
      const isAdmin = Array.isArray(req.user.roles) && req.user.roles.includes('admin');
      recordAuditLog(req.tenantDb, {
        org_id: req.orgId || req.user.orgId || null,
        actor_user_id: req.user.userId || null,
        actor_email: req.user.email || null,
        actor_role: isAdmin ? 'Admin' : (req.user.isAuditor ? 'Auditor' : null),
        action: d.action,
        module: d.module,
        method: req.method,
        path: d.path,
        entity_id: d.entity_id,
        status_code: res.statusCode,
        outcome: 'success',
        details: { changes: summarizeBody(req.body) },
        ip: req.ip || null,
        user_agent: req.headers?.['user-agent'] || null
      });
    } catch {
      // Never let auditing affect the response lifecycle.
    }
  });

  next();
}
