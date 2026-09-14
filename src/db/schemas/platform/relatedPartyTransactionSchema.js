/**
 * Related Party Transaction (RPT) Register — tenant DB.
 *
 * A standalone governance register that records actual (or anticipated)
 * transactions between the charity and a "related party" (a director, a
 * director's family member, key staff, or an entity they control). This is a
 * separate, ongoing ledger from a Conflict of Interest (COI) declaration: a COI
 * is the point-in-time *disclosure* that flags a potential RPT, whereas an RPT
 * record is the *transaction* that must be assessed, board-approved, and
 * disclosed (AASB 124 / ACNC related-party reporting).
 *
 * Records can be created manually or auto-created from a COI declaration (the
 * `source.coi_request_id` link). Materiality is classified against the org's
 * configured Approval Thresholds (petty_cash / low_cash / moderate_cash /
 * high_cash) — see relatedPartyTransactionService.assessRisk(). Risk-style: this
 * register stands on its own and does not pause any other workflow.
 */

import mongoose from 'mongoose';

// Why the related party is "related" — drives the relationship risk factor.
export const RELATIONSHIP_TYPES = [
  'director',            // a board member / director
  'responsible_person',  // ACNC responsible person
  'family_member',       // family of a director/responsible person
  'staff',               // employee
  'contractor',          // contractor / consultant
  'related_entity',      // a business the insider controls
  'other'
];

// What kind of dealing it is — the triggers from the COI workflow map here.
export const TRANSACTION_TYPES = [
  'purchase_goods_services', // org buys goods/services from the related party
  'provide_funds',           // org provides funds/grants to the related party
  'employment_contractor',   // employment or contractor arrangement
  'lease',                   // lease arrangement
  'loan',                    // loan arrangement
  'asset_transfer',          // sale/transfer of an asset
  'other'
];

// Materiality band, mirrored from the org's Approval Thresholds tiers.
export const VALUE_BANDS = ['petty_cash', 'low_cash', 'moderate_cash', 'high_cash'];

export const RISK_LEVELS = ['low', 'medium', 'high'];

export const RPT_STATUSES = [
  'identified',    // flagged (e.g. from a COI), not yet assessed
  'under_review',  // being assessed / awaiting board approval
  'approved',      // board-approved
  'rejected',      // declined
  'disclosed'      // included in annual disclosures
];

const supportingDocumentSchema = new mongoose.Schema(
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

// A single contributing factor in the risk assessment, kept for transparency
// so the detail page can show *why* a transaction scored the way it did.
const riskFactorSchema = new mongoose.Schema(
  {
    factor: { type: String, required: true }, // 'relationship' | 'value' | 'competitive_quotes'
    level: { type: String, enum: RISK_LEVELS, required: true },
    detail: { type: String, trim: true }
  },
  { _id: false }
);

const relatedPartyTransactionSchema = new mongoose.Schema(
  {
    org_id: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    rpt_number: { type: String, trim: true, index: true }, // RPT-2026-0001

    // ── The related party ──────────────────────────────────────────────
    related_party_name: { type: String, trim: true, required: true },
    relationship_type: { type: String, enum: RELATIONSHIP_TYPES, required: true },
    // The insider the relationship runs through (e.g. the director whose spouse
    // owns the supplier). Optionally references a board member record.
    related_person_name: { type: String, trim: true },
    related_board_member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BoardMember' },
    relationship_nature: { type: String, trim: true }, // free-text description

    // ── The transaction ────────────────────────────────────────────────
    transaction_description: { type: String, trim: true, required: true },
    transaction_type: { type: String, enum: TRANSACTION_TYPES, default: 'other' },
    transaction_value: { type: Number, min: 0, default: null },
    currency: { type: String, trim: true, default: 'AUD' },
    value_band: { type: String, enum: VALUE_BANDS, default: null }, // snapshot from thresholds
    is_recurring: { type: Boolean, default: false },
    competitive_quotes_obtained: { type: Boolean, default: false },

    identification_date: { type: Date, default: Date.now }, // when the RPT was identified
    transaction_date: { type: Date },

    // ── Governance / board approval ────────────────────────────────────
    conflicted_member_abstained: { type: Boolean, default: false },
    board_approval: {
      approved: { type: Boolean, default: false },
      approval_date: { type: Date },
      reference: { type: String, trim: true },        // board paper / resolution ref
      minute_reference: { type: String, trim: true }, // meeting minute reference
      approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    },

    // ── Risk assessment (derived; see service.assessRisk) ──────────────
    risk_level: { type: String, enum: RISK_LEVELS, default: 'low', index: true },
    risk_factors: { type: [riskFactorSchema], default: [] },
    requires_board_review: { type: Boolean, default: false },
    requires_audit_committee_review: { type: Boolean, default: false },

    // ── Disclosure ─────────────────────────────────────────────────────
    disclosure: {
      disclosed: { type: Boolean, default: false },
      financial_year: { type: String, trim: true }, // e.g. '2025-2026'
      disclosed_at: { type: Date }
    },

    supporting_documents: { type: [supportingDocumentSchema], default: [] },
    notes: { type: String, trim: true },

    status: { type: String, enum: RPT_STATUSES, default: 'identified', index: true },

    // ── Approval workflow ──────────────────────────────────────────────
    // The RPT runs its own approval workflow (final approver = board member).
    // Set when the workflow is triggered on creation; the COI it came from is
    // halted until this workflow is approved.
    approval_matrix_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalMatrix', default: null },
    approval_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', default: null },

    // ── Provenance ─────────────────────────────────────────────────────
    // How this record was created. 'coi' records carry the originating COI so
    // the audit trail runs declaration → assessment → approval → disclosure.
    source: {
      type: { type: String, enum: ['manual', 'coi'], default: 'manual' },
      coi_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CoiRequest', index: true }
    },

    is_active: { type: Boolean, default: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true, collection: 'related_party_transactions' }
);

relatedPartyTransactionSchema.index({ org_id: 1, status: 1, createdAt: -1 });
relatedPartyTransactionSchema.index({ org_id: 1, 'source.coi_request_id': 1 });

export default relatedPartyTransactionSchema;
