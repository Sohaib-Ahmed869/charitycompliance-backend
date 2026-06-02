/**
 * Inquiry Record Schema
 *
 * One filled-in instance of an Inquiry Template. The record snapshots
 * the template's custom_fields + workflow_steps at creation time so
 * later edits to the template can't retroactively change the shape of
 * in-flight records.
 *
 * Workflow advancement is self-contained — the record tracks
 * `current_step_index`, and the approve/reject endpoints walk forward
 * through `steps_snapshot`. Status moves pending → approved | rejected.
 * Risk-style: this register does NOT pause anything else; it stands on
 * its own.
 */

import mongoose from 'mongoose';

/** Materialised value for one custom field, as captured at record
 *  creation time. Either a free-text value OR a document reference
 *  (S3 key + uploaded filename). */
const fieldValueSchema = new mongoose.Schema({
  key:   { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  type:  { type: String, required: true, enum: ['text', 'document'] },
  // For type === 'text'
  value_text:    { type: String, default: null },
  // For type === 'document'
  value_file_key:  { type: String, default: null },
  value_file_name: { type: String, default: null },
  value_file_mime: { type: String, default: null }
}, { _id: false });

/** Snapshot of one workflow step + the action taken on it. */
const stepSnapshotSchema = new mongoose.Schema({
  name:                     { type: String, required: true, trim: true },
  approver_type:            { type: String, required: true, enum: ['user', 'position', 'board_member'] },
  approver_user_id:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approver_position_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'Position' },
  approver_board_member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BoardMember' },
  instructions:             { type: String, trim: true },

  /* Action tracking — populated as the step is completed. */
  status:      { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  acted_at:    { type: Date, default: null },
  acted_by:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  comments:    { type: String, trim: true, default: '' }
}, { _id: false });

const inquiryRecordSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  template_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InquiryTemplate',
    required: true,
    index: true
  },
  // Snapshots — captured at creation so template edits don't break
  // in-flight records.
  template_name:        { type: String, required: true, trim: true },
  parent_entity_type:       { type: String, required: true, enum: ['donor', 'project', 'employee', 'volunteer', 'supplier', 'bank', 'authority', 'custom'] },
  // Snapshotted free-text label when the template's parent type was
  // `custom`. Kept here so a record viewer doesn't need to re-fetch
  // the template just to render the section header.
  parent_entity_type_label: { type: String, trim: true, default: '' },
  // The id of the donor / project / employee / bank asset / authority
  // transfer this record attaches to. Schema doesn't ref a specific
  // collection — the frontend resolves by parent_entity_type.
  parent_entity_id:     { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  parent_entity_label:  { type: String, trim: true, default: '' },

  /** All the custom_fields as defined on the template, with the user's
   *  values filled in. Order matches the template's field order. */
  field_values: { type: [fieldValueSchema], default: [] },

  /** Workflow steps snapshot — frozen from the template at creation. */
  steps_snapshot: { type: [stepSnapshotSchema], default: [] },
  current_step_index: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  /**
   * The platform-wide ApprovalRequest that represents this record's
   * workflow. Created when the record is submitted so the record
   * appears in the central /approval-workflows view alongside every
   * other workflow on the platform.
   *
   * The inquiry record's steps_snapshot is kept as the source of
   * truth for action — approve/reject endpoints update both this
   * snapshot AND the linked ApprovalRequest's steps so the two stay
   * in sync.
   */
  approval_request_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApprovalRequest',
    index: true
  },

  submitted_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  submitted_at: { type: Date, default: Date.now },
  completed_at: { type: Date, default: null }
}, { timestamps: true });

inquiryRecordSchema.index({ org_id: 1, template_id: 1, createdAt: -1 });
inquiryRecordSchema.index({ org_id: 1, parent_entity_type: 1, parent_entity_id: 1 });

export default inquiryRecordSchema;
