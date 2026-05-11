/**
 * SuperAdmin (Router DB) — Calcite-internal accounts that operate the
 * pricing dashboard. Deliberately separate from the per-tenant User
 * collection so the boundary between Calcite ops and customer data stays
 * sharp: a super-admin has no tenant, no orgId, and no per-module
 * permissions — only the calcite.super_admin role.
 *
 * Created exclusively via scripts/createSuperAdmin.js. The script generates
 * a strong random password and prints it once; the database only ever
 * holds a bcrypt hash.
 */

import mongoose from 'mongoose';

const superAdminSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
  },
  password_hash: {
    type: String,
    required: true,
    select: false // never returned by default queries
  },
  full_name: {
    type: String,
    required: true,
    trim: true
  },
  /**
   * Calcite-side role:
   *   super_admin     — full access (plans, billing, tenants, invoices, audit, staff)
   *   billing_operator — invoices, payments, refunds, coupons; READ-ONLY on plans
   *   support_agent   — tickets, kanban boards, tenant read-only; cannot touch money
   *
   * Existing accounts default to 'super_admin' so the migration is safe.
   */
  role: {
    type: String,
    enum: ['super_admin', 'billing_operator', 'support_agent'],
    default: 'super_admin',
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'disabled'],
    default: 'active',
    index: true
  },
  // Bookkeeping for ops visibility — populated on every successful login.
  last_login_at: { type: Date, default: null },
  last_login_ip: { type: String, default: '' },
  failed_login_attempts: { type: Number, default: 0 },
  locked_until: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  // Who created this admin — null for the bootstrap account, otherwise
  // the SuperAdmin id of the creator (when we add a /admin/super-admins
  // CRUD screen in a later sprint).
  created_by: { type: mongoose.Schema.Types.ObjectId, default: null }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'super_admins'
});

export default superAdminSchema;
