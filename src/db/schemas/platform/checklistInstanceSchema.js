/**
 * Checklist Instance Schema (Tenant DB)
 *
 * Instance created from a template for a specific period/context.
 */

import mongoose from 'mongoose';

const evidenceSchema = new mongoose.Schema(
  {
    file_key: { type: String, required: true },
    file_name: { type: String },
    mime_type: { type: String },
    size: { type: Number },
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploaded_at: { type: Date, default: Date.now }
  },
  { _id: true }
);

// A single timestamped note authored by a user. Multiple notes are kept so a
// second (or third) person can add their own note to the same checklist item
// without overwriting earlier ones — an append-only thread. `author_name` is a
// denormalized fallback for display if the User ref can't be populated later.
const noteEntrySchema = new mongoose.Schema(
  {
    text: { type: String, trim: true, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    author_name: { type: String, trim: true },
    created_at: { type: Date, default: Date.now }
  },
  { _id: true }
);

const instanceItemSchema = new mongoose.Schema(
  {
    template_item_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    title_snapshot: { type: String, trim: true }, // denormalized for history
    description_snapshot: { type: String, trim: true },
    category_snapshot: { type: String, trim: true },
    type_snapshot: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    auto_rule_key_snapshot: { type: String, trim: true },
    required_evidence_snapshot: { type: String, enum: ['none', 'optional', 'required'], default: 'optional' },
    due_date: { type: Date },

    state: { type: String, enum: ['pending', 'satisfied', 'failed', 'skipped'], default: 'pending', index: true },
    checked: { type: Boolean, default: false },
    checked_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checked_at: { type: Date },
    // Legacy single-note field, kept for backward compatibility and the CSV
    // export. New notes are appended to `note_entries` (multi-note tracking).
    notes: { type: String, trim: true },
    note_entries: { type: [noteEntrySchema], default: [] },

    evidence: { type: [evidenceSchema], default: [] },

    override: {
      on: { type: Boolean, default: false },
      reason: { type: String, trim: true },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date }
    },

    evaluation_detail: { type: String, trim: true },
    last_evaluated_at: { type: Date },

    // CHKL-004 — IDs of other instance items in the same checklist that
    // must reach satisfied/checked before this item can be checked. Refers
    // to the `_id` of sibling items (sub-document _ids on this same
    // `items` array), captured from the template at instance creation.
    depends_on_item_ids: {
      type: [mongoose.Schema.Types.ObjectId],
      default: []
    }
  },
  { _id: true }
);

const checklistInstanceSchema = new mongoose.Schema(
  {
    entity_type: { type: String, enum: ['instance'], default: 'instance', immutable: true, index: true },
    org_id: { type: String, required: true, index: true },
    template_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChecklistTemplate', required: true, index: true },
    type: { type: String, required: true, trim: true, index: true }, // month_end | quarter_end | year_end | module
    period: {
      year: { type: Number, index: true },
      month: { type: Number, index: true }, // 1-12 for month_end; quarter_end uses 1/4/7/10 start month
      quarter: { type: Number, index: true } // 1-4 for quarter_end
    },
    context: { type: mongoose.Schema.Types.Mixed }, // { approvalRequestId } or { entityType, entityId }
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    closed_at: { type: Date },
    closed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    approval_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', index: true },

    items: { type: [instanceItemSchema], default: [] }
  },
  { timestamps: true, collection: 'checklists' }
);

checklistInstanceSchema.index({ org_id: 1, type: 1, 'period.year': 1, 'period.month': 1 });
checklistInstanceSchema.index({ org_id: 1, type: 1, 'period.year': 1, 'period.quarter': 1 });

export default checklistInstanceSchema;

