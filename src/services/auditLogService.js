/**
 * Audit Log Service
 *
 * Central writer for the append-only audit_logs collection plus the helpers
 * that sanitise request bodies before they are stored. Writes must NEVER
 * throw — auditing is best-effort and must not break the underlying request.
 */
import auditLogSchema from '../db/schemas/platform/auditLogSchema.js';
import { logError } from '../utils/logger.js';

// Keys whose values must never be persisted into the audit trail.
const SENSITIVE_KEY = /(password|secret|token|otp|mfa|signature|cvv|card[_-]?number|api[_-]?key|private[_-]?key|^auth$|authorization)/i;

export function getAuditLogModel(tenantDb) {
  return tenantDb.models.AuditLog || tenantDb.model('AuditLog', auditLogSchema);
}

/** Redact secrets and truncate large blobs so the stored detail stays small + safe. */
export function redactValue(key, value, depth = 0) {
  if (SENSITIVE_KEY.test(String(key || ''))) return '[redacted]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length > 300) return `[${value.length} chars]`;   // file blobs / base64
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (depth >= 2) return '[…]';
  if (Array.isArray(value)) {
    if (value.length > 25) return `[${value.length} items]`;
    return value.map((v, i) => redactValue(String(i), v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
    return out;
  }
  return value;
}

/** Shallow-summarise a request body into a redacted "changes" object. */
export function summarizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) out[k] = redactValue(k, v);
  return out;
}

/** Best-effort insert. Swallows all errors. */
export async function recordAuditLog(tenantDb, entry) {
  try {
    if (!tenantDb || !entry?.action) return;
    const AuditLog = getAuditLogModel(tenantDb);
    await AuditLog.create({ ...entry, created_at: entry.created_at || new Date() });
  } catch (err) {
    logError('Failed to write audit log', { error: err?.message, action: entry?.action });
  }
}
