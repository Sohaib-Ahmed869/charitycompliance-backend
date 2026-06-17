/**
 * Audit Log Schema (Tenant DB)
 *
 * Append-only record of every meaningful action: logins/logouts, and every
 * create / update / delete across all modules. Written by the global
 * mutation middleware (`auditLogger.js`) and the auth service. Read back by
 * the audit trail controller and merged with the derived events.
 *
 * One audit_logs collection lives per tenant DB, so every row already
 * belongs to a single org; `org_id` (the tenant slug) is stored for
 * traceability but is not required for scoping.
 */
import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  org_id: { type: String, default: null, index: true },              // tenant slug (req.orgId)
  actor_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  actor_name: { type: String, default: null },                       // snapshot when known (e.g. login)
  actor_email: { type: String, default: null },
  actor_role: { type: String, default: null },
  action: { type: String, required: true, trim: true },              // human label, e.g. "Updated expense"
  module: { type: String, default: 'general', trim: true },
  method: { type: String, default: null },                           // HTTP verb (mutations)
  path: { type: String, default: null },                             // route path after /platform/
  entity_type: { type: String, default: null },
  entity_id: { type: String, default: null },
  status_code: { type: Number, default: null },
  outcome: { type: String, default: 'success' },                     // success | failure
  details: { type: mongoose.Schema.Types.Mixed, default: {} },       // { changes: {...} } etc.
  ip: { type: String, default: null },
  user_agent: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false,
  collection: 'audit_logs'
});

auditLogSchema.index({ org_id: 1, created_at: -1 });
auditLogSchema.index({ actor_user_id: 1, created_at: -1 });

export default auditLogSchema;
