/**
 * Cash Handling / Donation Box Schema (Tenant DB)
 * - Collection points live under the "cash handling" module.
 * - Two categories:
 *     donation_box  — a physical box with a map location
 *     miscellaneous — fundraising events, online appeals, other one-off sources
 * - Each record contains an embedded list of collection entries (tips/amount received).
 * - The counting / acknowledgement / deposit workflow is identical for both categories.
 */

import mongoose from 'mongoose';

const donationBoxEntrySchema = new mongoose.Schema(
  {
    tips_count: {
      type: Number,
      min: 0,
      default: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    /**
     * Optional "expected" amount derived from receipts/banking records, used
     * for the variance check when cash is counted. If supplied and differs
     * from `amount` (for boxes) or `gross_amount` (for misc collections), the
     * UI surfaces a variance alert and we persist the difference for audit.
     */
    expected_amount: {
      type: Number,
      min: 0,
    },
    variance: {
      type: Number,
    },
    // CASH-010 — variance investigation documentation. Populated when the
    // counted variance is non-zero and someone has reviewed why. Free-form
    // notes + accountability fields so this is auditable.
    variance_investigation: {
      status: {
        type: String,
        enum: ['none', 'open', 'investigating', 'resolved', 'unresolved'],
        default: 'none',
      },
      notes: { type: String, default: '', trim: true },
      investigated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      investigated_at: { type: Date },
    },
    entry_date: {
      type: Date,
      required: true,
      index: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    /**
     * Miscellaneous-entry fields — only populated when the parent record is
     * category=miscellaneous (fundraising events, online appeals, etc.).
     * For donation_box entries these stay null/undefined and the existing
     * amount/tips_count fields are used instead.
     */
    gross_amount: { type: Number, min: 0 },
    expenses: { type: Number, min: 0, default: 0 },
    net_amount: { type: Number, min: 0 },
    participant_count: { type: Number, min: 0 },
    payment_method: {
      type: String,
      enum: ['cash', 'card', 'online', 'mixed', 'other'],
    },
    platform: { type: String, trim: true, default: '' },
    period_start: { type: Date },
    period_end: { type: Date },
    /** Cash handling workflow (per collection entry). */
    workflow_status: {
      type: String,
      enum: [
        'awaiting_second_counter_ack',
        'awaiting_office_ack',
        'awaiting_deposit',
        'completed',
      ],
      index: true,
    },
    /** Person who physically collected / emptied the box for this entry. */
    collector_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    collector_acknowledged_at: { type: Date },
    collector_acknowledged_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    /** Optional: a second person counted the cash (segregation of duties). */
    second_person_counted: { type: Boolean, default: false },
    second_counter_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    second_counter_acknowledged_at: { type: Date },
    second_counter_acknowledged_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    /** Office receipt acknowledgement (different person from collector where possible). */
    office_acknowledged_at: { type: Date },
    office_acknowledged_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    /** Final bank deposit confirmation (deposit slip). */
    deposit_confirmed_at: { type: Date },
    deposit_confirmed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    entry_closed_at: { type: Date },
    entry_closed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    workflow_events: [
      {
        step: { type: String, default: '' },
        action: { type: String, default: '' },
        at: { type: Date, default: Date.now },
        actor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String, default: '' },
      },
    ],
    /**
     * If false, the physical box is no longer at the location — box record may be set inactive.
     */
    box_still_at_location: { type: Boolean },
    proof_status: {
      type: String,
      enum: ['pending', 'submitted'],
      default: 'pending',
      index: true,
    },
    proof_assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    proof_files: [
      {
        name: { type: String, default: '' },
        size: { type: Number, default: 0 },
        type: { type: String, default: '' },
        url: { type: String, default: '' },
        key: { type: String, default: '' },
        uploaded_at: { type: Date, default: Date.now },
      },
    ],
    proof_added_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    proof_added_at: {
      type: Date,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { _id: true }
);

const donationBoxSchema = new mongoose.Schema(
  {
    org_id: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    /**
     * Cash-handling category.
     *   donation_box  — physical box with a map location
     *   miscellaneous — fundraising event, online appeal, etc.
     * Defaults to donation_box so existing records keep their current behaviour.
     */
    category: {
      type: String,
      enum: ['donation_box', 'miscellaneous'],
      default: 'donation_box',
      index: true,
    },
    /**
     * For miscellaneous items — the kind of collection (e.g. a fundraising event or an online appeal).
     * Ignored / null for donation_box records.
     */
    source_type: {
      type: String,
      enum: ['fundraising_event', 'online_fundraise', 'in_person_appeal', 'workplace_giving', 'other'],
    },
    /** Optional free-text context, used mainly by miscellaneous items. */
    description: {
      type: String,
      default: '',
      trim: true,
    },
    /**
     * Location is only required for donation_box records.
     * For miscellaneous items lat/lng are optional and can be omitted.
     */
    location: {
      lat: { type: Number },
      lng: { type: Number },
      address: { type: String, default: '' },
    },
    entries: {
      type: [donationBoxEntrySchema],
      default: [],
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false, collection: 'donation_boxes' }
);

donationBoxSchema.pre('save', function donationBoxPreSave(next) {
  this.updated_at = new Date();
  next();
});

// Basic indexes to keep common queries fast
donationBoxSchema.index({ org_id: 1, status: 1 });
donationBoxSchema.index({ org_id: 1, category: 1, status: 1 });
donationBoxSchema.index({ org_id: 1, name: 'text' });
donationBoxSchema.index({ org_id: 1, 'entries.entry_date': -1 });

export default donationBoxSchema;

