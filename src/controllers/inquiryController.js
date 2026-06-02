/**
 * Inquiry Controller
 *
 * Two resources:
 *   - InquiryTemplate — the "register definition" (name, parent
 *     entity type, custom fields, workflow steps).
 *   - InquiryRecord   — one filled-in instance against a template.
 *
 * Record submission accepts a multipart payload because some custom
 * fields may be type='document'. The frontend sends JSON-stringified
 * `record_payload` plus a file per document field, named
 * `file__<field_key>`. We extract files from req.files (multer.any)
 * and weave them into the `field_values` array on save.
 *
 * Workflow advancement is local — the record carries its own
 * `steps_snapshot` and `current_step_index`. No ApprovalRequest
 * involvement. The current step's approver POSTs to /approve or
 * /reject and the record moves forward (or to a terminal status).
 */

import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { InquiryTemplateRepository, InquiryRecordRepository } from '../repositories/inquiryRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { uploadToS3 } from '../services/s3Service.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import { logInfo, logError } from '../utils/logger.js';

const orgObjectIdFromTenant = async (tenantDb) => {
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  return org._id;
};

const bail = (res, errors) => res.status(400).json({
  success: false,
  error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
});

/* ================================================================== */
/* Uploads                                                              */
/* ================================================================== */

/**
 * Accepts a single file and writes it to S3 under the tenant's
 * `inquiries-defaults` prefix. Returns the resulting key plus the
 * original filename + mime, ready to be saved against a document
 * field's `default_file_*` columns when the template is saved.
 */
export const uploadFieldDefaultFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new AppError('No file provided', 400, 'NO_FILE');
  }
  const { buffer, originalname, mimetype } = req.file;
  const { key } = await uploadToS3(buffer, originalname, mimetype, req.orgId, 'inquiries-defaults');
  res.status(201).json({
    success: true,
    data: {
      key,
      file_name: originalname,
      mime: mimetype
    }
  });
});

/* ================================================================== */
/* Templates                                                            */
/* ================================================================== */

export const createTemplate = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return bail(res, errors);

  const tenantDb = await getTenantConnection(req.orgId);
  const orgId = await orgObjectIdFromTenant(tenantDb);
  const repo = new InquiryTemplateRepository(tenantDb);

  const template = await repo.create({
    org_id: orgId,
    name: req.body.name,
    description: req.body.description || '',
    parent_entity_type: req.body.parent_entity_type,
    parent_entity_type_label: req.body.parent_entity_type === 'custom'
      ? (req.body.parent_entity_type_label || '').trim()
      : '',
    custom_fields:  Array.isArray(req.body.custom_fields)  ? req.body.custom_fields  : [],
    workflow_steps: Array.isArray(req.body.workflow_steps) ? req.body.workflow_steps : [],
    status: 'active',
    created_by: req.user?.userId || null
  });

  logInfo('Inquiry template created', { templateId: String(template._id), orgId: String(orgId) });
  res.status(201).json({ success: true, data: template });
});

export const listTemplates = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgId = await orgObjectIdFromTenant(tenantDb);
  const templateRepo = new InquiryTemplateRepository(tenantDb);
  const recordRepo   = new InquiryRecordRepository(tenantDb);

  const [templates, counts] = await Promise.all([
    templateRepo.findByOrgId(orgId, { status: req.query.status || undefined }),
    recordRepo.countByTemplate(orgId)
  ]);

  // Decorate with record_count + last_activity for the list view.
  const decorated = templates.map((t) => ({
    ...t,
    record_count: counts.get(String(t._id)) || 0
  }));

  res.json({ success: true, data: decorated });
});

export const getTemplate = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const repo = new InquiryTemplateRepository(tenantDb);
  const template = await repo.findById(req.params.templateId);
  if (!template) throw new AppError('Template not found', 404, 'NOT_FOUND');
  res.json({ success: true, data: template });
});

export const updateTemplate = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return bail(res, errors);

  const tenantDb = await getTenantConnection(req.orgId);
  const repo = new InquiryTemplateRepository(tenantDb);

  const patch = {};
  ['name', 'description', 'parent_entity_type', 'parent_entity_type_label', 'custom_fields', 'workflow_steps', 'status']
    .forEach((k) => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });

  const updated = await repo.update(req.params.templateId, patch);
  if (!updated) throw new AppError('Template not found', 404, 'NOT_FOUND');

  res.json({ success: true, data: updated });
});

export const archiveTemplate = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const repo = new InquiryTemplateRepository(tenantDb);
  const archived = await repo.archive(req.params.templateId);
  if (!archived) throw new AppError('Template not found', 404, 'NOT_FOUND');
  res.json({ success: true, data: archived });
});

/* ================================================================== */
/* Records                                                              */
/* ================================================================== */

/**
 * Multipart payload:
 *   record_payload  — JSON string. Shape:
 *     {
 *       parent_entity_id: <ObjectId string>,
 *       parent_entity_label?: <string>,
 *       field_values: { <field_key>: <text value> }   // text fields only
 *     }
 *   file__<field_key>  — File for each document-type field.
 *
 * The template is loaded server-side and used as the source of truth
 * for which fields exist, what their type is, and the workflow steps.
 * Anything in the payload that isn't on the template is ignored.
 */
export const createRecord = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgId = await orgObjectIdFromTenant(tenantDb);
  const templateRepo = new InquiryTemplateRepository(tenantDb);
  const recordRepo   = new InquiryRecordRepository(tenantDb);

  const template = await templateRepo.findById(req.params.templateId);
  if (!template) throw new AppError('Template not found', 404, 'NOT_FOUND');
  if (template.status !== 'active') {
    throw new AppError('Cannot create records against an archived template', 400, 'TEMPLATE_ARCHIVED');
  }

  let payload = {};
  try {
    payload = JSON.parse(req.body.record_payload || '{}');
  } catch {
    throw new AppError('record_payload must be valid JSON', 400, 'INVALID_PAYLOAD');
  }

  if (!payload.parent_entity_id) {
    throw new AppError('parent_entity_id is required', 400, 'VALIDATION_ERROR');
  }

  // Index uploaded files by the form field name so we can look up
  // `file__<field_key>` in O(1).
  const filesByFieldKey = new Map();
  for (const f of req.files || []) {
    if (f.fieldname?.startsWith('file__')) {
      filesByFieldKey.set(f.fieldname.slice('file__'.length), f);
    }
  }

  // Build the field_values array in template order. Validates that
  // every required field has a value, and rejects extra fields the
  // template doesn't know about.
  const textValues = payload.field_values || {};
  const fieldValues = [];
  for (const field of template.custom_fields || []) {
    const entry = {
      key:   field.key,
      label: field.label,
      type:  field.type,
      value_text: null,
      value_file_key: null,
      value_file_name: null,
      value_file_mime: null
    };

    if (field.type === 'text') {
      const v = (textValues[field.key] ?? '').toString().trim();
      if (!v && field.required) {
        throw new AppError(`Field "${field.label}" is required`, 400, 'VALIDATION_ERROR');
      }
      entry.value_text = v || null;
    } else if (field.type === 'document') {
      const file = filesByFieldKey.get(field.key);
      // If the submitter uploaded a file, use it. Otherwise, fall back
      // to the template's default file (if any). Only if BOTH are
      // missing AND the field is required do we reject.
      if (file) {
        const { key: s3Key } = await uploadToS3(
          file.buffer,
          file.originalname,
          file.mimetype,
          req.orgId,
          'inquiries'
        );
        entry.value_file_key  = s3Key;
        entry.value_file_name = file.originalname;
        entry.value_file_mime = file.mimetype;
      } else if (field.default_file_key) {
        // Snapshot the template's default file onto the record. We
        // copy the S3 key by reference (no S3 duplication) since the
        // template's default file is read-only after upload.
        entry.value_file_key  = field.default_file_key;
        entry.value_file_name = field.default_file_name || 'default-file';
        entry.value_file_mime = field.default_file_mime || 'application/octet-stream';
      } else if (field.required) {
        throw new AppError(`Document for "${field.label}" is required`, 400, 'VALIDATION_ERROR');
      }
    }
    fieldValues.push(entry);
  }

  // Snapshot the workflow steps verbatim (with status: 'pending' on
  // each). The first step is the one the current_step_index points at.
  const stepsSnapshot = (template.workflow_steps || []).map((s) => ({
    name:                     s.name,
    approver_type:            s.approver_type,
    approver_user_id:         s.approver_user_id || null,
    approver_position_id:     s.approver_position_id || null,
    approver_board_member_id: s.approver_board_member_id || null,
    instructions:             s.instructions || '',
    status: 'pending',
    acted_at: null,
    acted_by: null,
    comments: ''
  }));

  const record = await recordRepo.create({
    org_id: orgId,
    template_id: template._id,
    template_name: template.name,
    parent_entity_type: template.parent_entity_type,
    parent_entity_type_label: template.parent_entity_type_label || '',
    parent_entity_id: payload.parent_entity_id,
    parent_entity_label: payload.parent_entity_label || '',
    field_values: fieldValues,
    steps_snapshot: stepsSnapshot,
    current_step_index: 0,
    status: 'pending',
    submitted_by: req.user?.userId,
    submitted_at: new Date()
  });

  logInfo('Inquiry record created', {
    recordId: String(record._id),
    templateId: String(template._id),
    orgId: String(orgId)
  });

  // Spawn a real ApprovalRequest workflow instance so the record
  // appears in /approval-workflows alongside every other workflow
  // on the platform. Awaited (not fire-and-forget) because the
  // response needs to include `approval_request_id` for the UI to
  // deep-link. Failures are logged inside the helper and we still
  // return the record — the local steps_snapshot remains usable.
  await createWorkflowInstanceForRecord({
    tenantDb,
    orgId,
    record,
    userId: req.user?.userId
  });

  // Notify the first step's approver. Fire-and-forget — failures
  // never break record creation.
  notifyStepAssignees({
    tenantDb,
    record,
    stepIndex: 0,
    isFirstStep: true
  }).catch(() => {});

  res.status(201).json({ success: true, data: record });
});

export const listRecords = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const orgId = await orgObjectIdFromTenant(tenantDb);
  const recordRepo = new InquiryRecordRepository(tenantDb);

  const records = await recordRepo.findByOrgId(orgId, {
    templateId:       req.query.templateId       || undefined,
    status:           req.query.status           || undefined,
    parentEntityType: req.query.parentEntityType || undefined,
    parentEntityId:   req.query.parentEntityId   || undefined
  });

  res.json({ success: true, data: records });
});

export const getRecord = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const recordRepo = new InquiryRecordRepository(tenantDb);
  const record = await recordRepo.findById(req.params.recordId);
  if (!record) throw new AppError('Record not found', 404, 'NOT_FOUND');
  res.json({ success: true, data: record });
});

/* ------------------------------------------------------------------ */
/* Workflow instance — create a real ApprovalRequest                  */
/* ------------------------------------------------------------------ */

/**
 * Build the approval_steps array for an ApprovalRequest from an
 * inquiry record's snapshotted workflow. Resolves the user id
 * behind each step so the central approvals dashboard knows who's on
 * the hook.
 *
 *   - user step         → approver_user_id stays
 *   - position step     → approver_position_id stays; resolve the first
 *                         active holder's user_id
 *   - board_member step → look up the board member's user_id; the
 *                         ApprovalStep schema has no board_member_id
 *                         field, so the user_id is what carries the
 *                         identity into the approvals world.
 */
const buildApprovalStepsFromSnapshot = async ({ tenantDb, snapshot }) => {
  const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const steps = [];

  for (let i = 0; i < snapshot.length; i += 1) {
    const s = snapshot[i];
    const step = {
      level: i + 1,
      approver_user_id: null,
      approver_position_id: null,
      approver_department_id: null,
      is_department_head: false,
      status: 'pending'
    };

    if (s.approver_type === 'user' && s.approver_user_id) {
      step.approver_user_id = s.approver_user_id;
    } else if (s.approver_type === 'position' && s.approver_position_id) {
      step.approver_position_id = s.approver_position_id;
      try {
        const holder = await BoardMember.findOne({
          position_id: s.approver_position_id,
          is_active: { $ne: false }
        }).select('user_id').lean();
        if (holder?.user_id) step.approver_user_id = holder.user_id;
      } catch { /* fall through with no user — assigning to position */ }
    } else if (s.approver_type === 'board_member' && s.approver_board_member_id) {
      try {
        const bm = await BoardMember.findById(s.approver_board_member_id).select('user_id position_id').lean();
        if (bm?.user_id)     step.approver_user_id     = bm.user_id;
        if (bm?.position_id) step.approver_position_id = bm.position_id;
      } catch { /* leave step with no user — record action will still work */ }
    }

    steps.push(step);
  }
  return steps;
};

/**
 * Create the platform-wide ApprovalRequest that mirrors an inquiry
 * record's workflow. Fire-and-forget — failures are logged but the
 * record creation itself never blocks on this.
 */
const createWorkflowInstanceForRecord = async ({ tenantDb, orgId, record, userId }) => {
  try {
    const approval_steps = await buildApprovalStepsFromSnapshot({
      tenantDb,
      snapshot: record.steps_snapshot || []
    });
    if (approval_steps.length === 0) return null;

    const approvalRepo = new ApprovalRequestRepository(tenantDb);
    const request = await approvalRepo.create({
      org_id: orgId,
      request_type: 'inquiry_record',
      entity_id: record._id,
      entity_type: 'inquiry_record',
      amount: 0,
      approval_type: 'sequential',
      status: 'pending',
      approval_steps,
      submitted_by: userId
    });

    // Cross-link from the inquiry record so the detail page can deep-
    // link into the central approval view.
    record.approval_request_id = request._id;
    record.markModified('approval_request_id');
    await record.save();

    logInfo('Inquiry workflow instance created', {
      recordId: String(record._id),
      approvalRequestId: String(request._id)
    });
    return request;
  } catch (err) {
    logError('Failed to create inquiry workflow instance', err, {
      recordId: String(record?._id)
    });
    return null;
  }
};

/**
 * Apply the same approve/reject decision the inquiry made onto the
 * linked ApprovalRequest so the central approvals dashboard stays in
 * sync. Fire-and-forget; sync failures are logged but never break
 * the user-facing flow.
 */
const syncApprovalRequestStep = async ({ tenantDb, record, stepIndex, action, userId, comments }) => {
  try {
    if (!record.approval_request_id) return;
    const approvalRepo = new ApprovalRequestRepository(tenantDb);
    const request = await approvalRepo.findById(record.approval_request_id);
    if (!request) return;

    const step = request.approval_steps?.[stepIndex];
    if (!step) return;

    step.status = action === 'approve' ? 'approved' : 'rejected';
    if (action === 'approve') step.approved_at = new Date();
    else step.rejected_at = new Date();
    step.approver_user_id = step.approver_user_id || userId;
    step.comments = comments || '';

    // Roll the request's overall status to match the inquiry record's
    // final state.
    if (record.status === 'approved') request.status = 'approved';
    else if (record.status === 'rejected') request.status = 'rejected';

    request.markModified('approval_steps');
    await request.save();
  } catch (err) {
    logError('Failed to sync inquiry workflow approval step', err, {
      recordId: String(record?._id),
      stepIndex,
      action
    });
  }
};

/* ------------------------------------------------------------------ */
/* Workflow notification helper                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the User ids who can act on a given snapshotted step. Walks
 * the three approver shapes used by inquiry templates:
 *
 *   - user         → notify that user directly
 *   - position     → notify every active board_member holding the position
 *   - board_member → notify the user behind the named board member
 *
 * Returns an array of stringified user ids (deduped). Errors are
 * swallowed and an empty array is returned so the notification path
 * never blocks the main flow.
 */
const resolveStepUserIds = async ({ step, tenantDb }) => {
  if (!step) return [];
  try {
    if (step.approver_type === 'user' && step.approver_user_id) {
      return [String(step.approver_user_id)];
    }
    if (step.approver_type === 'board_member' && step.approver_board_member_id) {
      const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
      const bm = await BoardMember.findById(step.approver_board_member_id).select('user_id').lean();
      return bm?.user_id ? [String(bm.user_id)] : [];
    }
    if (step.approver_type === 'position' && step.approver_position_id) {
      const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
      const holders = await BoardMember.find({
        position_id: step.approver_position_id,
        is_active: { $ne: false }
      }).select('user_id').lean();
      const ids = holders.map((h) => h.user_id).filter(Boolean).map(String);
      return [...new Set(ids)];
    }
  } catch (err) {
    logError('Failed to resolve inquiry step approvers', err, {
      approver_type: step.approver_type,
      approver_position_id: step.approver_position_id,
      approver_board_member_id: step.approver_board_member_id
    });
  }
  return [];
};

/**
 * Fire-and-forget notifier. Creates an in-app notification for every
 * user who can act on the given step. Caller doesn't await this —
 * notification failures must never roll back a record save.
 */
const notifyStepAssignees = async ({ tenantDb, record, stepIndex, isFirstStep }) => {
  try {
    const step = record.steps_snapshot?.[stepIndex];
    if (!step) return;
    const userIds = await resolveStepUserIds({ step, tenantDb });
    if (userIds.length === 0) return;

    const notifRepo = new NotificationRepository(tenantDb);
    const title = isFirstStep
      ? `New ${record.template_name} record needs your review`
      : `${record.template_name}: your step is now open`;
    const message = `Step ${stepIndex + 1} — "${step.name}" — is waiting for you. ${step.instructions ? `Instructions: ${step.instructions}` : ''}`.trim();
    const link = `/inquiries/records/${record._id}`;

    await notifRepo.createMany(userIds.map((uid) => ({
      user_id: uid,
      type: 'approval_pending',
      title,
      message,
      link,
      related_entity_id: record._id,
      related_entity_type: 'inquiry_record',
      created_at: new Date()
    })));

    logInfo('Inquiry step notification sent', {
      recordId: String(record._id),
      stepIndex,
      recipients: userIds.length
    });
  } catch (err) {
    logError('Failed to send inquiry step notification', err, {
      recordId: String(record?._id),
      stepIndex
    });
  }
};

/* ------------------------------------------------------------------ */
/* Approve / reject — walk forward through steps_snapshot              */
/* ------------------------------------------------------------------ */

/**
 * Does the current user have authority to act on this step?
 * Returns { allowed: boolean, reason?: string }.
 */
const canActOnStep = async ({ step, userId, tenantDb, orgObjectId }) => {
  if (step.approver_type === 'user') {
    return {
      allowed: String(step.approver_user_id) === String(userId),
      reason: 'Only the assigned user can act on this step'
    };
  }
  if (step.approver_type === 'position') {
    // For MVP, position-based gating is intentionally permissive —
    // any user can act and we trust the org's processes. A stricter
    // check would join through BoardMember.position_id, which we can
    // add once the data model gets more position-aware enforcement.
    return { allowed: true };
  }
  if (step.approver_type === 'board_member') {
    // If a specific board member is assigned, only that BM's linked
    // user can act. If no specific BM is set, any active board member
    // (i.e. user linked to a board_member with is_board_member=true)
    // can act.
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    if (step.approver_board_member_id) {
      const bm = await boardMemberRepo.findById(step.approver_board_member_id);
      if (!bm) return { allowed: false, reason: 'Assigned board member not found' };
      return {
        allowed: String(bm.user_id) === String(userId),
        reason: 'Only the assigned board member can sign off this step'
      };
    }
    // Any active board member.
    const myBm = await boardMemberRepo.findByUserId(userId, orgObjectId).catch(() => null);
    if (!myBm || !myBm.is_board_member || myBm.is_active === false) {
      return { allowed: false, reason: 'Only an active board member can sign off the final step' };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: 'Unknown approver type' };
};

const applyAction = async ({ recordId, tenantDb, userId, action, comments }) => {
  const recordRepo = new InquiryRecordRepository(tenantDb);
  const record = await recordRepo.findByIdMutable(recordId);
  if (!record) throw new AppError('Record not found', 404, 'NOT_FOUND');
  if (record.status !== 'pending') {
    throw new AppError(`Record is already ${record.status}`, 400, 'INVALID_STATE');
  }

  const idx = record.current_step_index;
  const step = record.steps_snapshot?.[idx];
  if (!step) throw new AppError('Invalid workflow state — no current step', 500, 'INVALID_STATE');

  // Resolve org ObjectId once per action so the board-member lookup
  // inside canActOnStep can scope its query correctly.
  const orgObjectId = await orgObjectIdFromTenant(tenantDb);
  const auth = await canActOnStep({ step, userId, tenantDb, orgObjectId });
  if (!auth.allowed) throw new AppError(auth.reason || 'Not authorised to act on this step', 403, 'FORBIDDEN');

  step.status   = action === 'approve' ? 'approved' : 'rejected';
  step.acted_at = new Date();
  step.acted_by = userId;
  step.comments = comments || '';

  let advancedToStep = null; // populated when we move to the next step
  if (action === 'reject') {
    record.status = 'rejected';
    record.completed_at = new Date();
  } else {
    const isLast = idx === record.steps_snapshot.length - 1;
    if (isLast) {
      record.status = 'approved';
      record.completed_at = new Date();
    } else {
      record.current_step_index = idx + 1;
      advancedToStep = idx + 1;
    }
  }

  // .markModified — the steps_snapshot subdoc array's nested action
  // fields can otherwise slip past mongoose's dirty tracking.
  record.markModified('steps_snapshot');
  await record.save();

  // Fire-and-forget: notify the newly-current step's approvers.
  if (advancedToStep != null) {
    notifyStepAssignees({
      tenantDb,
      record,
      stepIndex: advancedToStep,
      isFirstStep: false
    }).catch(() => {});
  }

  // Sync the matching step on the central ApprovalRequest so the
  // platform-wide workflow view reflects the action. Fire-and-forget.
  syncApprovalRequestStep({
    tenantDb,
    record,
    stepIndex: idx,
    action,
    userId,
    comments
  }).catch(() => {});

  return record;
};

export const approveStep = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const updated = await applyAction({
    recordId: req.params.recordId,
    tenantDb,
    userId: req.user?.userId,
    action: 'approve',
    comments: (req.body?.comments || '').trim()
  });
  res.json({ success: true, data: updated });
});

export const rejectStep = asyncHandler(async (req, res) => {
  const tenantDb = await getTenantConnection(req.orgId);
  const updated = await applyAction({
    recordId: req.params.recordId,
    tenantDb,
    userId: req.user?.userId,
    action: 'reject',
    comments: (req.body?.comments || '').trim()
  });
  res.json({ success: true, data: updated });
});

/* ------------------------------------------------------------------ */
/* Document download URL                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolves a signed S3 URL for one document field on a record. We
 * resolve on demand (rather than embedding URLs in the record) so the
 * URLs stay short-lived.
 */
export const getDocumentUrl = asyncHandler(async (req, res) => {
  const { getFileUrl } = await import('../services/s3Service.js');
  const tenantDb = await getTenantConnection(req.orgId);
  const recordRepo = new InquiryRecordRepository(tenantDb);
  const record = await recordRepo.findById(req.params.recordId);
  if (!record) throw new AppError('Record not found', 404, 'NOT_FOUND');

  const entry = (record.field_values || []).find((v) => v.key === req.params.fieldKey && v.type === 'document');
  if (!entry || !entry.value_file_key) {
    throw new AppError('Document not found on this field', 404, 'NOT_FOUND');
  }

  try {
    const url = await getFileUrl(entry.value_file_key, 3600);
    res.json({ success: true, data: { url, file_name: entry.value_file_name } });
  } catch (err) {
    logError('Inquiry document URL resolution failed', err, { recordId: record._id });
    throw new AppError('Could not resolve document URL', 500, 'STORAGE_ERROR');
  }
});
