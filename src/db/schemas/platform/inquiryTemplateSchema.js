/**
 * Inquiry Template Schema
 *
 * A user-defined "mini register". The platform's hard-coded registers
 * (donors, projects, employees, banking assets, authorities) cover the
 * common cases — when a tenant needs to track something the platform
 * doesn't model yet, they build an Inquiry Template here:
 *
 *   - name + description
 *   - parent_entity_type: which existing register a record attaches to
 *     (so records live alongside the parent's other context)
 *   - custom_fields: free-form data the user wants to capture
 *   - workflow_steps: who approves the record, in order
 *
 * Hard rule from the spec: the LAST workflow step must be a board
 * member. Enforced by a pre('validate') hook below and mirrored in the
 * route validator so the user gets a 400 with a friendly message
 * rather than a 500 from the schema.
 *
 * Templates are tenant-scoped (org_id) and immutable in spirit — once
 * records exist against a template, editing the template should NOT
 * retroactively change in-flight records. The record snapshots its
 * template's fields + workflow at creation time (see
 * inquiryRecordSchema) so this guarantee is enforced.
 */

import mongoose from 'mongoose';

/**
 * One custom field the template asks the user to fill in when they
 * create a record. Two types only for the MVP — text (string input)
 * and document (file upload, stored in S3). The frontend renders an
 * appropriate input per type.
 */
const customFieldSchema = new mongoose.Schema({
  key: {
    // Slug used as the property name on the record's field_values
    // object (e.g. "donor_history"). Lower-case, underscore-separated.
    type: String,
    required: true,
    trim: true,
    match: [/^[a-z][a-z0-9_]*$/, 'Field key must start with a letter and contain only lowercase letters, digits, and underscores']
  },
  label: {
    // Human-readable label shown above the input.
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    enum: ['text', 'document'],
    default: 'text'
  },
  required: {
    type: Boolean,
    default: false
  },
  placeholder: { type: String, trim: true },
  help_text:   { type: String, trim: true },
  /**
   * Preset value baked into the template. When a record is created
   * the form opens with this value already filled in — the submitter
   * can still override it. Only meaningful for `type === 'text'`.
   */
  default_value: { type: String, trim: true, default: '' },
  /**
   * Default attachment for document fields. The submitter sees this
   * file pre-selected and can either accept it or upload a
   * replacement. Populated by uploading a file via the template
   * builder; carried verbatim onto records that don't override.
   */
  default_file_key:  { type: String, trim: true, default: '' },
  default_file_name: { type: String, trim: true, default: '' },
  default_file_mime: { type: String, trim: true, default: '' }
}, { _id: false });

/**
 * One step in the inquiry's approval workflow. Three approver shapes:
 *   - user:         a specific User by id
 *   - position:     anyone holding a specific Position (resolved at
 *                   record submission time via the standard
 *                   approval-matrix helper)
 *   - board_member: any active board member (last step ONLY)
 *
 * The split mirrors how the existing ApprovalWorkflowService resolves
 * approvers, so we can later swap this for ApprovalRequest if the
 * workflow grows complex.
 */
const workflowStepSchema = new mongoose.Schema({
  name: {
    // Label for the step (e.g. "Manager review", "Director sign-off").
    type: String,
    required: true,
    trim: true
  },
  approver_type: {
    type: String,
    required: true,
    enum: ['user', 'position', 'board_member']
  },
  approver_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approver_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  approver_board_member_id: {
    // Optional — if left null on a board_member step, ANY active board
    // member can sign off. If set, only that specific board member
    // can complete the step.
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BoardMember'
  },
  instructions: { type: String, trim: true }
}, { _id: false });

const inquiryTemplateSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  parent_entity_type: {
    // Which existing register a record attaches to. The pre-built
    // values map to canonical pickers on the frontend; `custom` is
    // an escape hatch for user-defined attachment targets that don't
    // map to any platform module — those use a free-text reference
    // (paired with `parent_entity_type_label` below).
    type: String,
    required: true,
    enum: ['donor', 'project', 'employee', 'volunteer', 'supplier', 'bank', 'authority', 'custom'],
    index: true
  },
  /**
   * Free-text display name used when `parent_entity_type === 'custom'`.
   * Lets a tenant name their own register type (e.g. "External
   * Consultant", "Grant Recipient", "Subcontractor"). Ignored for
   * pre-built types.
   */
  parent_entity_type_label: {
    type: String,
    trim: true,
    default: ''
  },
  custom_fields:   { type: [customFieldSchema],   default: [] },
  workflow_steps:  { type: [workflowStepSchema],  default: [] },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

/* ------------------------------------------------------------------ */
/* Cross-field validation                                              */
/* ------------------------------------------------------------------ */

inquiryTemplateSchema.pre('validate', function (next) {
  // The spec requires the LAST workflow step to be a board member.
  // Done as a hook (not on the sub-schema) because it depends on the
  // step's position in the array.
  const steps = this.workflow_steps || [];
  if (steps.length === 0) {
    return next(new mongoose.Error.ValidationError(
      new Error('At least one workflow step is required')
    ));
  }
  const last = steps[steps.length - 1];
  if (last.approver_type !== 'board_member') {
    const err = new mongoose.Error.ValidationError(this);
    err.addError('workflow_steps', new mongoose.Error.ValidatorError({
      path: 'workflow_steps',
      message: 'The last workflow step must be a board member sign-off'
    }));
    return next(err);
  }

  // Custom field keys must be unique within a template — otherwise
  // record.field_values would silently overwrite earlier values.
  const seen = new Set();
  for (const f of this.custom_fields || []) {
    if (seen.has(f.key)) {
      const err = new mongoose.Error.ValidationError(this);
      err.addError('custom_fields', new mongoose.Error.ValidatorError({
        path: 'custom_fields',
        message: `Duplicate field key: ${f.key}`
      }));
      return next(err);
    }
    seen.add(f.key);
  }

  next();
});

inquiryTemplateSchema.index({ org_id: 1, name: 1 });

export default inquiryTemplateSchema;
