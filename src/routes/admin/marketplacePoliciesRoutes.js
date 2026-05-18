/**
 * SuperAdmin endpoints for the Policy Marketplace catalogue.
 *
 *   GET    /admin/policy-templates/groups            — list all groups
 *   POST   /admin/policy-templates/groups            — create group
 *   PATCH  /admin/policy-templates/groups/:id        — update group
 *   DELETE /admin/policy-templates/groups/:id        — archive group
 *
 *   GET    /admin/policy-templates/policies?group=…  — list policies
 *   POST   /admin/policy-templates/policies          — create + upload (multipart, field name: file)
 *   GET    /admin/policy-templates/policies/:id      — single policy
 *   PATCH  /admin/policy-templates/policies/:id      — update metadata
 *   POST   /admin/policy-templates/policies/:id/file — replace file (multipart)
 *   DELETE /admin/policy-templates/policies/:id      — archive policy
 *   GET    /admin/policy-templates/policies/:id/download — presigned S3 URL
 *
 * All endpoints require an authenticated Calcite SuperAdmin (gated by
 * requireSuperAdmin). Marketplace is global to every tenant so the data
 * lives in the Router DB; no x-org-id is needed.
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler, AppError } from '../../middleware/errorHandler.js';
import { uploadPolicySingle, handlePolicyUploadError } from '../../middleware/upload.js';
import { uploadToS3, getFileUrl, deleteFromS3 } from '../../services/s3Service.js';
import getRouterModels from '../../db/models/routerModels.js';

const router = express.Router();

router.use(authenticate);
router.use(requireSuperAdmin);

// ── helpers ─────────────────────────────────────────────────────────

/** "Governance Essentials" → "governance-essentials". */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Resolves a unique slug by suffixing -2, -3, … on collisions. */
async function uniqueSlug(MarketplacePolicyGroup, base, ignoreId = null) {
  const root = slugify(base) || 'group';
  let candidate = root;
  let i = 2;
  while (true) {
    const q = { slug: candidate };
    if (ignoreId) q._id = { $ne: ignoreId };
    const hit = await MarketplacePolicyGroup.findOne(q).lean();
    if (!hit) return candidate;
    candidate = `${root}-${i++}`;
    if (i > 100) throw new AppError('Could not find a free slug', 500, 'SLUG_OVERFLOW');
  }
}

/** Sniff the upload format from the multer file object — PDF / DOCX only. */
function detectFormat(file) {
  const mime = (file?.mimetype || '').toLowerCase();
  const ext  = '.' + (file?.originalname || '').split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || mime === 'application/msword'
      || ext === '.docx' || ext === '.doc') return 'docx';
  return null;
}

function serializeGroup(g) {
  if (!g) return null;
  return {
    id: g._id?.toString(),
    name: g.name,
    slug: g.slug,
    description: g.description || '',
    sort_order: g.sort_order ?? 100,
    status: g.status,
    accent_color: g.accent_color || '',
    created_at: g.created_at,
    updated_at: g.updated_at
  };
}

function serializePolicy(p) {
  if (!p) return null;
  return {
    id: p._id?.toString(),
    group_id: p.group_id?.toString(),
    title: p.title,
    description: p.description || '',
    summary: p.summary || '',
    price_aud_cents: p.price_aud_cents ?? 0,
    price_aud: ((p.price_aud_cents ?? 0) / 100), // convenience for the UI
    file: {
      original_name: p.file?.original_name || '',
      format: p.file?.format || 'pdf',
      bytes: p.file?.bytes || 0,
      mime_type: p.file?.mime_type || ''
      // s3 keys deliberately not exposed — the download endpoint
      // returns a presigned URL when an operator wants the file.
    },
    tags: p.tags || [],
    version: p.version ?? 1,
    status: p.status,
    created_at: p.created_at,
    updated_at: p.updated_at
  };
}

// ─────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────

/** GET /admin/policy-templates/groups */
router.get(
  '/policy-templates/groups',
  [query('status').optional().isIn(['active', 'archived', 'all'])],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicyGroup, MarketplacePolicy } = getRouterModels();
    const status = req.query.status || 'active';
    const filter = status === 'all' ? {} : { status };
    const groups = await MarketplacePolicyGroup
      .find(filter)
      .sort({ sort_order: 1, created_at: -1 })
      .lean();

    // One aggregate query gets the per-group policy counts in one round-trip.
    const ids = groups.map((g) => g._id);
    const counts = ids.length
      ? await MarketplacePolicy.aggregate([
          { $match: { group_id: { $in: ids } } },
          { $group: { _id: { gid: '$group_id', status: '$status' }, n: { $sum: 1 } } }
        ])
      : [];
    const countMap = {};
    for (const row of counts) {
      const gid = row._id.gid.toString();
      countMap[gid] = countMap[gid] || { draft: 0, published: 0, archived: 0, total: 0 };
      countMap[gid][row._id.status] = row.n;
      countMap[gid].total += row.n;
    }

    res.json({
      success: true,
      data: groups.map((g) => ({ ...serializeGroup(g), policy_counts: countMap[g._id.toString()] || { draft: 0, published: 0, archived: 0, total: 0 } }))
    });
  })
);

/** POST /admin/policy-templates/groups */
router.post(
  '/policy-templates/groups',
  [
    body('name').isString().trim().isLength({ min: 1, max: 120 }),
    body('description').optional().isString().trim().isLength({ max: 1000 }),
    body('sort_order').optional().isInt({ min: 0, max: 9999 }),
    body('accent_color').optional().isString().trim().isLength({ max: 32 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicyGroup } = getRouterModels();
    const slug = await uniqueSlug(MarketplacePolicyGroup, req.body.name);
    const doc = await MarketplacePolicyGroup.create({
      name: req.body.name,
      slug,
      description: req.body.description || '',
      sort_order: req.body.sort_order ?? 100,
      accent_color: req.body.accent_color || '',
      created_by: req.user?.userId || null
    });
    res.status(201).json({ success: true, data: serializeGroup(doc) });
  })
);

/** PATCH /admin/policy-templates/groups/:id */
router.patch(
  '/policy-templates/groups/:id',
  [
    param('id').isMongoId(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('description').optional().isString().trim().isLength({ max: 1000 }),
    body('sort_order').optional().isInt({ min: 0, max: 9999 }),
    body('accent_color').optional().isString().trim().isLength({ max: 32 }),
    body('status').optional().isIn(['active', 'archived'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicyGroup } = getRouterModels();
    const doc = await MarketplacePolicyGroup.findById(req.params.id);
    if (!doc) throw new AppError('Group not found', 404, 'GROUP_NOT_FOUND');

    if (req.body.name && req.body.name !== doc.name) {
      doc.name = req.body.name;
      // Regenerate slug only if name changed AND admin didn't pass one.
      doc.slug = await uniqueSlug(MarketplacePolicyGroup, req.body.name, doc._id);
    }
    if (typeof req.body.description === 'string') doc.description = req.body.description;
    if (typeof req.body.sort_order === 'number') doc.sort_order = req.body.sort_order;
    if (typeof req.body.accent_color === 'string') doc.accent_color = req.body.accent_color;
    if (req.body.status) doc.status = req.body.status;
    await doc.save();
    res.json({ success: true, data: serializeGroup(doc) });
  })
);

/** DELETE /admin/policy-templates/groups/:id — soft archive */
router.delete(
  '/policy-templates/groups/:id',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicyGroup } = getRouterModels();
    const doc = await MarketplacePolicyGroup.findById(req.params.id);
    if (!doc) throw new AppError('Group not found', 404, 'GROUP_NOT_FOUND');
    doc.status = 'archived';
    await doc.save();
    res.json({ success: true, data: serializeGroup(doc) });
  })
);

// ─────────────────────────────────────────────────────────────────────
// Policies
// ─────────────────────────────────────────────────────────────────────

/** GET /admin/policy-templates/policies?group=:id&status=… */
router.get(
  '/policy-templates/policies',
  [
    query('group').optional().isMongoId(),
    query('status').optional().isIn(['draft', 'published', 'archived', 'all'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const filter = {};
    if (req.query.group) filter.group_id = req.query.group;
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    const docs = await MarketplacePolicy.find(filter).sort({ created_at: -1 }).lean();
    res.json({ success: true, data: docs.map(serializePolicy) });
  })
);

/** GET /admin/policy-templates/policies/:id */
router.get(
  '/policy-templates/policies/:id',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const doc = await MarketplacePolicy.findById(req.params.id).lean();
    if (!doc) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');
    res.json({ success: true, data: serializePolicy(doc) });
  })
);

/**
 * POST /admin/policy-templates/policies — multipart upload.
 *
 * Body fields (multipart form):
 *   file        — required (PDF or DOCX, ≤50 MB)
 *   group_id    — required, Mongo id of the parent group
 *   title       — required
 *   description — optional
 *   summary     — optional
 *   price_aud_cents — required integer ≥0 (0 = free)
 *   tags        — optional, JSON-encoded string array
 *   status      — optional 'draft' | 'published' (default 'draft')
 */
router.post(
  '/policy-templates/policies',
  uploadPolicySingle,
  handlePolicyUploadError,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy, MarketplacePolicyGroup } = getRouterModels();
    if (!req.file) throw new AppError('File is required', 400, 'FILE_REQUIRED');

    const format = detectFormat(req.file);
    if (!format) {
      throw new AppError('Only PDF and DOCX files are accepted', 400, 'UNSUPPORTED_FORMAT');
    }

    const groupId = req.body.group_id;
    if (!groupId || !groupId.match(/^[0-9a-fA-F]{24}$/)) {
      throw new AppError('Valid group_id is required', 400, 'GROUP_REQUIRED');
    }
    const group = await MarketplacePolicyGroup.findById(groupId).lean();
    if (!group) throw new AppError('Group not found', 404, 'GROUP_NOT_FOUND');

    const title = (req.body.title || '').toString().trim();
    if (!title) throw new AppError('Title is required', 400, 'TITLE_REQUIRED');

    const priceCents = Number(req.body.price_aud_cents);
    if (!Number.isFinite(priceCents) || priceCents < 0 || !Number.isInteger(priceCents)) {
      throw new AppError('price_aud_cents must be a non-negative integer', 400, 'PRICE_INVALID');
    }

    let tags = [];
    if (req.body.tags) {
      try {
        const parsed = JSON.parse(req.body.tags);
        if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
      } catch { /* swallow — tags are optional */ }
    }

    const status = ['draft', 'published'].includes(req.body.status) ? req.body.status : 'draft';

    // Upload to S3 under a marketplace-scoped key path. The s3 helper
    // accepts an `orgId` which it also uses as a top-level key segment
    // — passing "_marketplace" keeps the file out of any tenant prefix.
    const upload = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      '_marketplace',
      'policy-template'
    );

    const doc = await MarketplacePolicy.create({
      group_id: group._id,
      title,
      description: (req.body.description || '').toString().trim(),
      summary: (req.body.summary || '').toString().trim().slice(0, 240),
      price_aud_cents: priceCents,
      file: {
        s3_key: upload.key,
        original_name: req.file.originalname,
        mime_type: req.file.mimetype,
        format,
        bytes: upload.bytes,
        pdf_preview_key: format === 'pdf' ? upload.key : '' // Phase 2 fills in for DOCX
      },
      tags,
      version: 1,
      status,
      created_by: req.user?.userId || null
    });
    res.status(201).json({ success: true, data: serializePolicy(doc) });
  })
);

/** PATCH /admin/policy-templates/policies/:id — metadata only */
router.patch(
  '/policy-templates/policies/:id',
  [
    param('id').isMongoId(),
    body('title').optional().isString().trim().isLength({ min: 1, max: 240 }),
    body('description').optional().isString().trim().isLength({ max: 4000 }),
    body('summary').optional().isString().trim().isLength({ max: 240 }),
    body('price_aud_cents').optional().isInt({ min: 0 }),
    body('tags').optional().isArray(),
    body('status').optional().isIn(['draft', 'published', 'archived'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const doc = await MarketplacePolicy.findById(req.params.id);
    if (!doc) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');

    if (typeof req.body.title === 'string')           doc.title = req.body.title;
    if (typeof req.body.description === 'string')     doc.description = req.body.description;
    if (typeof req.body.summary === 'string')         doc.summary = req.body.summary;
    if (typeof req.body.price_aud_cents === 'number') doc.price_aud_cents = req.body.price_aud_cents;
    if (Array.isArray(req.body.tags))                 doc.tags = req.body.tags.filter((t) => typeof t === 'string').map((t) => t.trim());
    if (req.body.status)                              doc.status = req.body.status;
    await doc.save();
    res.json({ success: true, data: serializePolicy(doc) });
  })
);

/** POST /admin/policy-templates/policies/:id/file — replace the file */
router.post(
  '/policy-templates/policies/:id/file',
  uploadPolicySingle,
  handlePolicyUploadError,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const doc = await MarketplacePolicy.findById(req.params.id);
    if (!doc) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');
    if (!req.file) throw new AppError('File is required', 400, 'FILE_REQUIRED');

    const format = detectFormat(req.file);
    if (!format) {
      throw new AppError('Only PDF and DOCX files are accepted', 400, 'UNSUPPORTED_FORMAT');
    }

    const upload = await uploadToS3(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      '_marketplace',
      'policy-template'
    );

    // Best-effort: try to remove the prior S3 object. If it fails we
    // log and move on — orphaned files are recoverable from S3, but
    // losing the new policy reference would be worse.
    const oldKey = doc.file?.s3_key;
    if (oldKey) {
      deleteFromS3(oldKey, '_marketplace').catch(() => {});
    }

    doc.file = {
      s3_key: upload.key,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      format,
      bytes: upload.bytes,
      pdf_preview_key: format === 'pdf' ? upload.key : ''
    };
    doc.version = (doc.version || 1) + 1;
    await doc.save();
    res.json({ success: true, data: serializePolicy(doc) });
  })
);

/** DELETE /admin/policy-templates/policies/:id — soft archive */
router.delete(
  '/policy-templates/policies/:id',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const doc = await MarketplacePolicy.findById(req.params.id);
    if (!doc) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');
    doc.status = 'archived';
    await doc.save();
    res.json({ success: true, data: serializePolicy(doc) });
  })
);

/** GET /admin/policy-templates/policies/:id/download — presigned URL (admin sanity check) */
router.get(
  '/policy-templates/policies/:id/download',
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { MarketplacePolicy } = getRouterModels();
    const doc = await MarketplacePolicy.findById(req.params.id).lean();
    if (!doc) throw new AppError('Policy not found', 404, 'POLICY_NOT_FOUND');
    if (!doc.file?.s3_key) throw new AppError('Policy has no file attached', 404, 'FILE_MISSING');
    const url = await getFileUrl(doc.file.s3_key, 300); // 5 min
    res.json({ success: true, data: { url, expires_in: 300 } });
  })
);

export default router;
