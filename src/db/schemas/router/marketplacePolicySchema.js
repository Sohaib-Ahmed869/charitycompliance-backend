/**
 * MarketplacePolicy (Router DB) — one purchasable policy template in
 * the Policy Marketplace. Belongs to a MarketplacePolicyGroup.
 *
 * Files live on S3 (uploaded via /admin/policy-templates endpoints).
 * For DOCX uploads we keep the original DOCX as the "source of truth"
 * the buyer eventually downloads, plus a PDF preview key for the
 * tenant-side watermarked viewer. PDF uploads use the same key for
 * both fields (no conversion needed).
 *
 * Pricing is stored in cents (AUD) to avoid floating-point drift.
 * `price_aud_cents: 0` is allowed — represents a free template.
 */

import mongoose from 'mongoose';

const fileMetaSchema = new mongoose.Schema({
  s3_key:        { type: String, required: true },
  original_name: { type: String, default: '' },
  mime_type:     { type: String, default: '' },
  // 'pdf' | 'docx' — drives whether the tenant-side viewer needs the
  // preview key or can serve the source file directly.
  format:        { type: String, enum: ['pdf', 'docx'], required: true },
  bytes:         { type: Number, default: 0 },
  // For DOCX uploads we generate a PDF copy for the in-browser viewer
  // (Phase 2 will populate this). For PDF uploads this can stay null
  // and the viewer falls back to s3_key.
  pdf_preview_key: { type: String, default: '' },

  // Cached, Stewardex-branded, SINGLE-PAGE preview PDF for the public
  // marketplace card thumbnails + preview modal. Generated lazily on the
  // first preview-stream request and reused thereafter, so we don't
  // re-run pdf-lib branding (and re-stream the whole multi-page document)
  // on every card render. Naturally cleared when `file` is reassigned on
  // a file replacement, which is exactly when it needs regenerating.
  branded_preview_key: { type: String, default: '' }
}, { _id: false });

const marketplacePolicySchema = new mongoose.Schema({
  group_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MarketplacePolicyGroup',
    required: true,
    index: true
  },

  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: '',
    trim: true
  },
  // Short marketing line shown in the marketplace tile (~120 chars).
  summary: {
    type: String,
    default: '',
    trim: true,
    maxlength: 240
  },

  // AUD cents. 0 = free template. Validated >=0; controller enforces
  // integer-cents semantics so the form can accept "$199" and convert.
  price_aud_cents: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },

  file: { type: fileMetaSchema, required: true },

  // Optional pillar tags (Governance, Finance, Risk, …). Free-form for
  // now — the admin UI offers a suggestion list but doesn't enforce it.
  tags: [{ type: String, trim: true }],

  // Editorial version — bumped manually when the SuperAdmin uploads a
  // new file. Tenants who already bought get a "new version available"
  // hint in Phase 3; here we just store the integer.
  version: { type: Number, default: 1 },

  // draft   — being edited, not visible to tenants
  // published — live in the marketplace
  // archived — hidden from marketplace, existing purchases still resolve
  status: {
    type: String,
    enum: ['draft', 'published', 'archived'],
    default: 'draft',
    index: true
  },

  created_by: { type: mongoose.Schema.Types.ObjectId, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'marketplace_policies'
});

// Browse by group + status (the marketplace list query) and recency.
marketplacePolicySchema.index({ group_id: 1, status: 1, created_at: -1 });
marketplacePolicySchema.index({ status: 1, created_at: -1 });

export default marketplacePolicySchema;
