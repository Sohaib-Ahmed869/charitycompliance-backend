import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { DisciplinaryRecordRepository } from '../repositories/disciplinaryRecordRepository.js';
import { ComplaintRepository } from '../repositories/complaintRepository.js';

async function getOrgObjectId(orgId) {
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  return { tenantDb, orgObjectId: org._id };
}

export const createDisciplinaryRecord = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const { tenantDb, orgObjectId } = await getOrgObjectId(orgId);
  const repo = new DisciplinaryRecordRepository(tenantDb);

  const staffMemberId = req.body.staff_member_id;
  if (!staffMemberId) {
    throw new AppError('Staff member is required', 400, 'VALIDATION_ERROR');
  }

  const staffNameSnapshot = req.body.staff_name_snapshot || req.body.staff_name || '';
  const staffPositionSnapshot = req.body.staff_position_snapshot || req.body.staff_position || '';

  const record = await repo.create({
    org_id: orgObjectId,
    staff_member_id: staffMemberId,
    staff_name_snapshot: staffNameSnapshot,
    staff_position_snapshot: staffPositionSnapshot,
    issue_type: req.body.issue_type,
    description: req.body.description,
    status: 'open',
    created_by_user_id: userId
  });

  res.status(201).json({ success: true, data: record });
});

export const listDisciplinaryRecords = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { tenantDb, orgObjectId } = await getOrgObjectId(orgId);
  const repo = new DisciplinaryRecordRepository(tenantDb);

  const { status, search } = req.query;
  const records = await repo.findByOrg(orgObjectId, { status, search });
  res.json({ success: true, data: records });
});

export const updateDisciplinaryRecord = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const recordId = req.params.recordId;
  const { tenantDb, orgObjectId } = await getOrgObjectId(orgId);
  const repo = new DisciplinaryRecordRepository(tenantDb);

  const existing = await repo.findById(recordId);
  if (!existing || String(existing.org_id) !== String(orgObjectId)) {
    throw new AppError('Disciplinary record not found', 404, 'DISCIPLINARY_NOT_FOUND');
  }

  const payload = {};
  if (req.body.status) payload.status = req.body.status;
  if (req.body.resolution_type !== undefined) payload.resolution_type = req.body.resolution_type;
  if (req.body.training_title !== undefined) payload.training_title = req.body.training_title;
  if (req.body.linked_training_id !== undefined) payload.linked_training_id = req.body.linked_training_id || null;
  if (req.body.training_date !== undefined) payload.training_date = req.body.training_date;
  if (req.body.resolution_notes !== undefined) payload.resolution_notes = req.body.resolution_notes;

  const updated = await repo.update(recordId, payload);
  res.json({ success: true, data: updated });
});

export const convertDisciplinaryRecordToComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const recordId = req.params.recordId;
  const { tenantDb, orgObjectId } = await getOrgObjectId(orgId);

  const repo = new DisciplinaryRecordRepository(tenantDb);
  const complaintRepo = new ComplaintRepository(tenantDb);

  const existing = await repo.findById(recordId);
  if (!existing || String(existing.org_id) !== String(orgObjectId)) {
    throw new AppError('Disciplinary record not found', 404, 'DISCIPLINARY_NOT_FOUND');
  }
  if (existing.converted_to_complaint || existing.converted_complaint_id) {
    throw new AppError('This disciplinary record has already been converted to a complaint', 400, 'ALREADY_CONVERTED');
  }

  const {
    complainant_name,
    complainant_email,
    complainant_occupation,
    complaint_title,
    description,
    submit_anonymously,
    priority,
    attachments
  } = req.body || {};

  if (!complainant_name || !String(complainant_name).trim()) {
    throw new AppError('Complainant name is required', 400, 'VALIDATION_ERROR');
  }
  if (!complainant_email || !String(complainant_email).trim()) {
    throw new AppError('Complainant email is required', 400, 'VALIDATION_ERROR');
  }
  if (!complaint_title || !String(complaint_title).trim()) {
    throw new AppError('Complaint title is required', 400, 'VALIDATION_ERROR');
  }
  if (!description || !String(description).trim()) {
    throw new AppError('Description is required', 400, 'VALIDATION_ERROR');
  }

  const complaint = await complaintRepo.create({
    org_id: orgObjectId,
    complainant_name: String(complainant_name).trim(),
    complainant_email: String(complainant_email).trim().toLowerCase(),
    complainant_occupation: complainant_occupation ? String(complainant_occupation).trim() : '',
    complaint_title: String(complaint_title).trim(),
    description: String(description).trim(),
    category: null,
    submit_anonymously: !!submit_anonymously,
    submission_method: 'website',
    status: 'new',
    workflow_stage: 'admin_triage',
    priority: priority || 'medium',
    dept_head_approval_decision: 'pending',
    admin_approval_decision: 'pending',
    attachments: Array.isArray(attachments)
      ? attachments.map((a) => ({
          filename: a?.filename || '',
          size: a?.size || '',
          mime: a?.mime || '',
          data_url: a?.data_url || '',
          uploaded_at: new Date(),
          uploaded_by: userId || null,
        }))
      : [],
    trail: [
      {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'created_from_disciplinary_record',
        details: { disciplinary_record_id: String(recordId) },
      },
    ],
    notes: `Converted from disciplinary record ${String(recordId)}`
  });

  const updated = await repo.update(recordId, {
    converted_to_complaint: true,
    converted_complaint_id: complaint?._id || null,
    converted_at: new Date(),
    converted_by_user_id: userId || null
  });

  res.status(201).json({
    success: true,
    data: {
      disciplinary_record: updated,
      complaint
    }
  });
});

