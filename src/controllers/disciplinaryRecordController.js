import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { DisciplinaryRecordRepository } from '../repositories/disciplinaryRecordRepository.js';

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

