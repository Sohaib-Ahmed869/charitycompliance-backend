/**
 * assetImporter — bulk-import config for the IT / Asset Register.
 *
 * Each row becomes an asset via the same `AssetService.createAsset` path
 * the single-asset form uses (minus the file upload — imported rows carry
 * no documentation attachment).
 *
 * Dedup: a row is skipped when its serial number or asset name matches an
 * asset already on file (or an earlier row in the same upload).
 *
 * Assets have no per-record approval workflow category, so there is no
 * `approval` block — the engine records each created row's approval state
 * as 'skipped'. (If an asset approval category is ever added, wire it here
 * exactly like supplierImporter.)
 */

import { AssetRepository } from '../../repositories/assetRepository.js';
import { AssetService } from '../assetService.js';

const CATEGORIES = [
  'Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture',
  'Software', 'Hardware', 'Subscription', 'Domain', 'Cloud Service',
  'Banking Details', 'Other'
];

const str = (v) => String(v ?? '').trim();

const toIsoDate = (v) => {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const validateRow = (raw) => {
  const errors = [];
  const asset_name = str(raw?.asset_name);
  const type = str(raw?.type);
  let category = str(raw?.category);

  if (!asset_name) errors.push({ field: 'asset_name', message: 'Asset name is required' });
  if (!type) errors.push({ field: 'type', message: 'Asset type is required' });

  // Accept category case-insensitively; normalise to the canonical casing.
  if (!category) {
    errors.push({ field: 'category', message: 'Category is required' });
  } else {
    const match = CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
    if (!match) errors.push({ field: 'category', message: `Category must be one of: ${CATEGORIES.join(', ')}` });
    else category = match;
  }

  const worthRaw = str(raw?.worth);
  const worth = parseFloat(worthRaw);
  if (worthRaw === '' || Number.isNaN(worth) || worth < 0) {
    errors.push({ field: 'worth', message: 'Worth must be a number of 0 or more' });
  }

  const purchase_date = toIsoDate(raw?.purchase_date);
  if (!purchase_date) errors.push({ field: 'purchase_date', message: 'A valid purchase date is required' });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      asset_name,
      category,
      type,
      vendor_name: str(raw?.vendor_name) || undefined,
      model: str(raw?.model) || undefined,
      serial_number: str(raw?.serial_number) || undefined,
      worth,
      department_owner: str(raw?.department_owner) || undefined,
      purchase_date,
      maintenance_date: toIsoDate(raw?.maintenance_date) || undefined,
      status: str(raw?.status).toLowerCase() || 'active',
      notes: str(raw?.notes) || undefined
    }
  };
};

export const assetImporter = {
  entityName: 'asset',

  labelOf: (x) => x?.asset_name || null,

  validateRow,

  dedupe: {
    keyOf: (data) =>
      (data.serial_number && `serial:${data.serial_number.toLowerCase()}`)
      || (data.asset_name && `name:${data.asset_name.toLowerCase()}`)
      || null,
    findExisting: (ctx, data) =>
      ctx.assetRepo.findExistingByDedup(ctx.orgId, {
        serialNumber: data.serial_number,
        assetName: data.asset_name
      })
  },

  prepare: ({ tenantDb, orgId }) => ({
    assetRepo: new AssetRepository(tenantDb),
    assetService: new AssetService(orgId)
  }),

  // Reuse AssetService.createAsset so imported assets get the exact same
  // server-side normalisation as the single-asset form. org_id is the
  // tenant slug for assets (the service sets it from its constructor arg).
  createOne: (ctx, data) => ctx.assetService.createAsset(data, ctx.actor.userId)
};

export default assetImporter;
