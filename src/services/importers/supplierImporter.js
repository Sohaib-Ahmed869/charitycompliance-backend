/**
 * supplierImporter — bulk-import config for the Supplier Register.
 *
 * Plugs into `bulkImportService.runBulkImport`. Each imported row becomes
 * a draft supplier (identical to one created via the single-supplier form)
 * and is then submitted into the org's `supplier_vetting` approval workflow,
 * exactly like clicking "Submit for vetting" on the detail page.
 *
 * Dedup: a row is skipped when its ABN, contact email, or legal name
 * matches a supplier already on file (or an earlier row in the same upload).
 */

import { SupplierRepository } from '../../repositories/supplierRepository.js';
import { OrganizationRepository } from '../../repositories/organizationRepository.js';
import { raiseEntityApproval } from '../importApprovalService.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORIES = ['goods', 'services', 'professional', 'utility', 'contractor', 'other'];
const PAYMENT_TERMS = ['net_7', 'net_14', 'net_30', 'net_60', 'prepaid', 'cod'];

const str = (v) => String(v ?? '').trim();
const bool = (v) => {
  const s = str(v).toLowerCase();
  return ['true', 'yes', 'y', '1', 'gst', 'registered'].includes(s);
};

/** Validate + map one spreadsheet row into supplier create data. */
const validateRow = (raw) => {
  const errors = [];
  const legal_name = str(raw?.legal_name);
  const contact_email = str(raw?.contact_email).toLowerCase();
  const abn = str(raw?.abn).replace(/\s+/g, '');
  const category = str(raw?.category).toLowerCase();
  const payment_terms = str(raw?.payment_terms).toLowerCase();

  if (!legal_name) errors.push({ field: 'legal_name', message: 'Legal name is required' });
  if (contact_email && !EMAIL_RE.test(contact_email)) {
    errors.push({ field: 'contact_email', message: 'Invalid email address' });
  }
  if (category && !CATEGORIES.includes(category)) {
    errors.push({ field: 'category', message: `Category must be one of: ${CATEGORIES.join(', ')}` });
  }
  if (payment_terms && !PAYMENT_TERMS.includes(payment_terms)) {
    errors.push({ field: 'payment_terms', message: `Payment terms must be one of: ${PAYMENT_TERMS.join(', ')}` });
  }

  if (errors.length > 0) return { ok: false, errors };

  const address = {
    line1: str(raw?.address_line1) || undefined,
    line2: str(raw?.address_line2) || undefined,
    suburb: str(raw?.suburb) || undefined,
    state: str(raw?.state) || undefined,
    postcode: str(raw?.postcode) || undefined,
    country: str(raw?.country) || undefined
  };
  const hasAddress = Object.values(address).some(Boolean);

  return {
    ok: true,
    data: {
      legal_name,
      trading_name: str(raw?.trading_name) || undefined,
      abn: abn || undefined,
      acn: str(raw?.acn).replace(/\s+/g, '') || undefined,
      contact_name: str(raw?.contact_name) || undefined,
      contact_email: contact_email || undefined,
      contact_phone: str(raw?.contact_phone) || undefined,
      ...(hasAddress ? { address } : {}),
      category: category || 'goods',
      payment_terms: payment_terms || 'net_30',
      gst_registered: raw?.gst_registered === undefined || raw?.gst_registered === '' ? undefined : bool(raw?.gst_registered),
      notes: str(raw?.notes) || undefined
    }
  };
};

export const supplierImporter = {
  entityName: 'supplier',

  labelOf: (x) => x?.legal_name || null,

  validateRow,

  dedupe: {
    keyOf: (data) =>
      (data.abn && `abn:${data.abn}`)
      || (data.contact_email && `email:${data.contact_email}`)
      || (data.legal_name && `name:${data.legal_name.toLowerCase()}`)
      || null,
    findExisting: (ctx, data) =>
      ctx.supplierRepo.findActiveByDedupKeys(ctx.orgObjectId, {
        abn: data.abn,
        contactEmail: data.contact_email,
        legalName: data.legal_name
      })
  },

  prepare: async ({ tenantDb }) => {
    const supplierRepo = new SupplierRepository(tenantDb);
    const org = await new OrganizationRepository(tenantDb).findOne();
    if (!org) {
      const err = new Error('Organization not found');
      err.code = 'ORG_NOT_FOUND';
      throw err;
    }
    return { supplierRepo, orgObjectId: org._id };
  },

  createOne: async (ctx, data) => {
    const supplier_number = await ctx.supplierRepo.nextSupplierNumber(ctx.orgObjectId);
    return ctx.supplierRepo.create({
      ...data,
      supplier_number,
      org_id: ctx.orgObjectId,
      vetting_status: 'draft',
      created_by: ctx.actor.userId,
      updated_by: ctx.actor.userId
    });
  },

  approval: {
    category: 'supplier_vetting',
    raise: async (ctx, supplier) => {
      const request = await raiseEntityApproval({
        tenantDb: ctx.tenantDb,
        orgSlug: ctx.orgId,
        orgObjectId: ctx.orgObjectId,
        category: 'supplier_vetting',
        requestType: 'supplier_vetting',
        entityType: 'supplier',
        entity: supplier,
        amount: 0,
        submittedBy: ctx.actor.userId,
        title: `Supplier vetting — ${supplier.legal_name}`,
        description: `Supplier ${supplier.supplier_number}: vetting workflow (bulk import)`
      });
      // Mirror submitForVetting: flip the supplier into pending_review and
      // point it at the new request so the register + detail page reflect it.
      await ctx.supplierRepo.update(supplier._id, {
        vetting_status: 'pending_review',
        approval_request_id: request._id,
        rejection_reason: null,
        updated_by: ctx.actor.userId
      });
      return { state: 'submitted' };
    }
  }
};

export default supplierImporter;
