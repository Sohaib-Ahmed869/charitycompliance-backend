/**
 * Checklist Template Schema (Tenant DB)
 *
 * Used for reusable finance/month-end/quarter/year-end templates and module checklists.
 */

import mongoose from 'mongoose';

const templateItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, trim: true, default: 'General' },
    type: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    requiredEvidence: { type: String, enum: ['none', 'optional', 'required'], default: 'optional' },
    assigneeRole: { type: String, trim: true }, // e.g. Finance Manager
    dueOffsetDays: { type: Number }, // optional convenience
    autoRuleKey: { type: String, trim: true }, // for type=auto
    dependencies: [{ type: String, trim: true }], // templateItemIds
    sortOrder: { type: Number, default: 0 }
  },
  { _id: true }
);

const checklistTemplateSchema = new mongoose.Schema(
  {
    org_id: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true }, // month_end | quarter_end | year_end | module
    description: { type: String, trim: true },
    items: { type: [templateItemSchema], default: [] },
    is_active: { type: Boolean, default: true, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true, collection: 'checklist_templates' }
);

checklistTemplateSchema.index({ org_id: 1, type: 1, is_active: 1 });

export default checklistTemplateSchema;

