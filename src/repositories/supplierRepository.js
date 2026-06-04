/**
 * Supplier Repository
 *
 * Per-request, tenant-bound. Construct with `new SupplierRepository(req.tenantDb)`
 * so the model is bound to the right tenant database, never to the global
 * mongoose registry.
 */

import supplierSchema from '../db/schemas/platform/supplierSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import { createBlindIndex } from '../utils/encryption.js';
import { getMasterKeyHex } from '../config/encryption.js';

export class SupplierRepository {
  constructor(tenantDb) {
    this.Supplier = tenantDb.models.Supplier
      || tenantDb.model('Supplier', supplierSchema);
    // Ensure populate('approval_request_id') resolves on the same
    // connection — otherwise mongoose throws MissingSchemaError when
    // it tries to look the model up on the default connection.
    if (!tenantDb.models.ApprovalRequest) {
      tenantDb.model('ApprovalRequest', approvalRequestSchema);
    }
  }

  // ---- List + search ---------------------------------------------------

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.vetting_status) query.vetting_status = filters.vetting_status;
    if (filters.category)       query.category       = filters.category;
    if (typeof filters.is_active === 'boolean') query.is_active = filters.is_active;

    if (filters.search) {
      const re = new RegExp(filters.search, 'i');
      query.$or = [
        { legal_name: re },
        { trading_name: re },
        { supplier_number: re }
        // ABN / contact_email are encrypted — searching by them uses the
        // blind-index hash columns the encrypt plugin maintains. Callers
        // wanting equality match on those fields can pass `abn_hash` or
        // `contact_email_hash` explicitly.
      ];
    }

    return this.Supplier.find(query).sort({ createdAt: -1 });
  }

  /**
   * Compact projection for the expense-form typeahead. Only returns
   * approved, active, not-expired records. NEVER includes bank details.
   */
  async findForDropdown(orgId) {
    const now = new Date();
    const docs = await this.Supplier.find({
      org_id: orgId,
      vetting_status: 'approved',
      is_active: true,
      $or: [
        { expires_at: { $exists: false } },
        { expires_at: null },
        { expires_at: { $gt: now } }
      ]
    })
      .select('_id supplier_number legal_name trading_name abn category gst_registered payment_terms default_currency')
      .sort({ legal_name: 1 })
      .lean();
    // Mask ABN — only the last 4 reach the client for display.
    return docs.map((d) => ({
      ...d,
      abn_last4: d.abn ? String(d.abn).replace(/\s+/g, '').slice(-4) : null,
      abn: undefined
    }));
  }

  // ---- Dedup lookup ----------------------------------------------------
  /**
   * Find an active supplier in this org that matches any of the supplied
   * dedup keys. ABN and contact_email are encrypted, so we match on the
   * blind-index hash columns the encrypt plugin maintains (`abn_hash`,
   * `contact_email_hash`); legal_name is plaintext and matched
   * case-insensitively. Returns the first match or null.
   *
   * Used by the bulk-import engine to skip rows that duplicate a supplier
   * already on file. Quietly returns null when no usable key is supplied.
   */
  async findActiveByDedupKeys(orgId, { abn, contactEmail, legalName } = {}) {
    const or = [];
    const keyHex = getMasterKeyHex();

    if (keyHex && keyHex.length === 64) {
      const cleanAbn = String(abn || '').replace(/\s+/g, '').trim();
      if (cleanAbn) or.push({ abn_hash: createBlindIndex(cleanAbn, keyHex) });
      const email = String(contactEmail || '').trim().toLowerCase();
      if (email) or.push({ contact_email_hash: createBlindIndex(email, keyHex) });
    }

    const name = String(legalName || '').trim();
    if (name) {
      // Anchored, case-insensitive exact match on the (plaintext) legal name.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      or.push({ legal_name: new RegExp(`^${escaped}$`, 'i') });
    }

    if (or.length === 0) return null;
    return this.Supplier.findOne({ org_id: orgId, is_active: true, $or: or });
  }

  // ---- Single record ---------------------------------------------------

  async findById(id) {
    return this.Supplier.findById(id);
  }

  async findByIdWithWorkflow(id) {
    return this.Supplier.findById(id)
      .populate('approval_request_id');
  }

  // ---- CRUD ------------------------------------------------------------

  async create(data) {
    const supplier = new this.Supplier(data);
    return supplier.save();
  }

  async update(id, updateData) {
    return this.Supplier.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return this.Supplier.findByIdAndDelete(id);
  }

  // ---- Counts (for KpiStrip) -------------------------------------------

  async getCountsByOrg(orgId) {
    const all = await this.Supplier.find({ org_id: orgId })
      .select('vetting_status is_active expires_at')
      .lean();
    const now = new Date();
    const expiringWindow = new Date();
    expiringWindow.setDate(now.getDate() + 90);

    return {
      total: all.length,
      approved: all.filter((s) => s.vetting_status === 'approved' && s.is_active).length,
      pending: all.filter((s) => s.vetting_status === 'pending_review').length,
      rejected: all.filter((s) => s.vetting_status === 'rejected').length,
      draft: all.filter((s) => s.vetting_status === 'draft').length,
      inactive: all.filter((s) => !s.is_active).length,
      expiring_soon: all.filter((s) =>
        s.vetting_status === 'approved'
        && s.is_active
        && s.expires_at
        && s.expires_at >= now
        && s.expires_at <= expiringWindow
      ).length
    };
  }

  // ---- Auto-numbering --------------------------------------------------
  /**
   * Generate the next supplier_number for an org. Pattern:
   *   SUP-<YYYY>-<4-digit zero-padded sequence>
   * Sequence is per-year, scoped to the org. Safe under low concurrency
   * (every register page that creates one supplier at a time). For
   * heavier write paths, swap for a dedicated counter collection.
   */
  async nextSupplierNumber(orgId) {
    const year = new Date().getFullYear();
    const prefix = `SUP-${year}-`;
    // Find the highest existing number for this org + year.
    const latest = await this.Supplier.find({
      org_id: orgId,
      supplier_number: new RegExp(`^${prefix}`)
    })
      .select('supplier_number')
      .sort({ supplier_number: -1 })
      .limit(1)
      .lean();
    const latestSeq = latest[0]
      ? parseInt(String(latest[0].supplier_number).split('-').pop(), 10) || 0
      : 0;
    const next = (latestSeq + 1).toString().padStart(4, '0');
    return `${prefix}${next}`;
  }

  // ---- Expiry sweeps ---------------------------------------------------

  async findExpiringSoon(orgId, daysAhead = 90) {
    const now = new Date();
    const horizon = new Date();
    horizon.setDate(now.getDate() + daysAhead);
    return this.Supplier.find({
      org_id: orgId,
      vetting_status: 'approved',
      is_active: true,
      expires_at: { $gte: now, $lte: horizon }
    })
      .select('_id legal_name supplier_number expires_at')
      .sort({ expires_at: 1 })
      .lean();
  }
}
