/**
 * ApprovalPdfCache (Tenant DB)
 *
 * One row per approval workflow. Tracks the S3 key of the most recently
 * generated audit PDF plus the workflow's `updatedAt` timestamp at the
 * moment it was rendered. The ZIP exporter checks this before spending
 * a Puppeteer render — if `source_updated_at` is still ≥ workflow.updatedAt,
 * the cached PDF is reused, otherwise we re-render and overwrite.
 *
 * Kept as a separate collection (rather than fields on ApprovalRequest)
 * so infra-cache concerns don't pollute the domain schema.
 */

import mongoose from 'mongoose';

const approvalPdfCacheSchema = new mongoose.Schema({
  workflow_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    unique: true,
    index: true
  },
  s3_key:               { type: String, required: true },
  bytes:                { type: Number, default: 0 },
  // Snapshot of workflow.updatedAt at the moment we rendered. The
  // cache is considered fresh while workflow.updatedAt ≤ this value.
  source_updated_at:    { type: Date,   required: true },
  // Bumped manually whenever the PDF renderer changes shape (new
  // sections, layout tweaks, copy changes). The export service
  // compares against PDF_TEMPLATE_VERSION at lookup time — a mismatch
  // forces a fresh render so cached PDFs never lag the template.
  template_version:     { type: String, default: 'v1' },
  generated_at:         { type: Date,   default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'approval_pdf_cache'
});

export default approvalPdfCacheSchema;
