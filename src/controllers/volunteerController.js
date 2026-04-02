import mongoose from 'mongoose';
import { validationResult } from 'express-validator';
import { getTenantConnection } from '../db/connectionManager.js';
import { AppError, asyncHandler } from '../middleware/errorHandler.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ComplaintRepository } from '../repositories/complaintRepository.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { PolicyRepository } from '../repositories/policyRepository.js';
import { PolicyAcknowledgementRepository } from '../repositories/policyAcknowledgementRepository.js';
import { getFileStream } from '../services/s3Service.js';
import emailService from '../services/emailService.js';
import {
  createVolunteerActionToken,
  resolveVolunteerActionToken,
  markVolunteerActionTokenUsed,
} from '../services/volunteerActionTokenService.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

async function getVolunteerContextFromToken(token, expectedType = null) {
  const tokenDoc = await resolveVolunteerActionToken(token, expectedType);
  if (!tokenDoc) throw new AppError('Invalid or expired volunteer action link', 401, 'INVALID_TOKEN');

  const tenantDb = await getTenantConnection(tokenDoc.org_id);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const volunteer = await boardMemberRepo.findByIdWithRelations(tokenDoc.board_member_id);
  const org = await orgRepo.findOne();
  if (!volunteer || !org) throw new AppError('Volunteer or organization not found', 404, 'NOT_FOUND');
  return { tokenDoc, tenantDb, volunteer, org };
}

export const generateVolunteerActionLinks = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() },
    });
  }

  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const volunteer = await boardMemberRepo.findById(boardMemberId);
  if (!volunteer) throw new AppError('Volunteer not found', 404, 'NOT_FOUND');
  if (!volunteer.is_volunteer) throw new AppError('Board member is not marked as volunteer', 400, 'NOT_VOLUNTEER');
  if (!volunteer.email) throw new AppError('Volunteer email is required to generate links', 400, 'VOLUNTEER_EMAIL_REQUIRED');

  const [complaintDoc, riskDoc, coiDoc] = await Promise.all([
    createVolunteerActionToken({
      orgId,
      boardMemberId,
      actionType: 'complaint',
      email: volunteer.email,
    }),
    createVolunteerActionToken({
      orgId,
      boardMemberId,
      actionType: 'risk',
      email: volunteer.email,
    }),
    createVolunteerActionToken({
      orgId,
      boardMemberId,
      actionType: 'coi',
      email: volunteer.email,
    }),
  ]);

  res.json({
    success: true,
    data: {
      complaint: `${FRONTEND_URL}/public/volunteer/complaint/${complaintDoc.token}`,
      risk: `${FRONTEND_URL}/public/volunteer/risk/${riskDoc.token}`,
      coi: `${FRONTEND_URL}/public/volunteer/coi/${coiDoc.token}`,
    },
  });
});

export const getVolunteerActionContext = asyncHandler(async (req, res) => {
  const { actionType, token } = req.params;

  if (actionType === 'policy_ack') {
    const tokenDoc = await resolveVolunteerActionToken(token, 'policy_ack');
    if (!tokenDoc) throw new AppError('Invalid or expired volunteer action link', 401, 'INVALID_TOKEN');
    const policyIdRaw = tokenDoc.metadata?.policy_id;
    if (!policyIdRaw) throw new AppError('Invalid policy link', 400, 'INVALID_POLICY_TOKEN');

    const { volunteer, org, tenantDb } = await getVolunteerContextFromToken(token, 'policy_ack');
    const policyRepo = new PolicyRepository(tenantDb);
    const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);

    let policyId;
    try {
      policyId = new mongoose.Types.ObjectId(String(policyIdRaw));
    } catch {
      throw new AppError('Invalid policy reference', 400, 'INVALID_POLICY_ID');
    }

    const policy = await policyRepo.findById(policyId);
    if (!policy || policy.org_id.toString() !== org._id.toString()) {
      throw new AppError('Policy not found', 404, 'NOT_FOUND');
    }
    if (policy.status !== 'active') {
      throw new AppError('This policy is not active for acknowledgement', 400, 'POLICY_NOT_ACTIVE');
    }

    const existing = await acknowledgementRepo.findOneByPolicyAndBoardMember(policy._id, volunteer._id);
    const volunteerName = [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' ').trim() || 'Volunteer';

    return res.json({
      success: true,
      data: {
        volunteer: {
          id: volunteer._id,
          name: volunteerName,
          email: volunteer.email,
        },
        organization: { name: org.name },
        actionType: 'policy_ack',
        policy: {
          id: policy._id,
          title: policy.title,
          category: policy.category,
          version: policy.version,
          effective_date: policy.effective_date,
          review_date: policy.review_date,
          file_name: policy.file_name,
          mime_type: policy.mime_type,
          has_document: !!policy.file_path,
        },
        acknowledged: !!existing,
      },
    });
  }

  const { volunteer, org } = await getVolunteerContextFromToken(token, actionType);
  res.json({
    success: true,
    data: {
      volunteer: {
        id: volunteer._id,
        name: [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' '),
        email: volunteer.email,
      },
      organization: {
        name: org.name,
      },
      actionType,
    },
  });
});

/** Stream policy PDF for public volunteer acknowledgement (no login). */
export const streamVolunteerPolicyPdf = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const tokenDoc = await resolveVolunteerActionToken(token, 'policy_ack');
  if (!tokenDoc) throw new AppError('Invalid or expired volunteer action link', 401, 'INVALID_TOKEN');
  const policyIdRaw = tokenDoc.metadata?.policy_id;
  if (!policyIdRaw) throw new AppError('Invalid policy link', 400, 'INVALID_POLICY_TOKEN');

  const { org, tenantDb } = await getVolunteerContextFromToken(token, 'policy_ack');
  const policyRepo = new PolicyRepository(tenantDb);
  let policyId;
  try {
    policyId = new mongoose.Types.ObjectId(String(policyIdRaw));
  } catch {
    throw new AppError('Invalid policy reference', 400, 'INVALID_POLICY_ID');
  }
  const policy = await policyRepo.findById(policyId);
  if (!policy || policy.org_id.toString() !== org._id.toString()) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }
  if (!policy.file_path) {
    throw new AppError('Policy has no document', 404, 'NO_CONTENT');
  }

  const rangeHeader = req.headers.range || null;
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await getFileStream(policy.file_path, rangeHeader);

  res.setHeader('Content-Type', ContentType || 'application/pdf');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});

/** Acknowledge policy via volunteer token (no login). */
export const acknowledgeVolunteerPolicy = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const tokenDoc = await resolveVolunteerActionToken(token, 'policy_ack');
  if (!tokenDoc) throw new AppError('Invalid or expired volunteer action link', 401, 'INVALID_TOKEN');
  const policyIdRaw = tokenDoc.metadata?.policy_id;
  if (!policyIdRaw) throw new AppError('Invalid policy link', 400, 'INVALID_POLICY_TOKEN');

  const { volunteer, org, tenantDb } = await getVolunteerContextFromToken(token, 'policy_ack');
  const policyRepo = new PolicyRepository(tenantDb);
  const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);

  let policyId;
  try {
    policyId = new mongoose.Types.ObjectId(String(policyIdRaw));
  } catch {
    throw new AppError('Invalid policy reference', 400, 'INVALID_POLICY_ID');
  }

  const policy = await policyRepo.findById(policyId);
  if (!policy || policy.org_id.toString() !== org._id.toString()) {
    throw new AppError('Policy not found', 404, 'NOT_FOUND');
  }
  if (policy.status !== 'active') {
    throw new AppError('Only active policies can be acknowledged', 400, 'POLICY_NOT_ACTIVE');
  }

  const signatureData = typeof req.body?.signature_data === 'string' ? req.body.signature_data : null;
  const userName = [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' ').trim() || volunteer.email || 'Volunteer';
  const userTitle = volunteer.position || volunteer.custom_position_title || undefined;

  const acknowledgement = await acknowledgementRepo.acknowledgeByBoardMember(
    policy._id,
    volunteer._id,
    signatureData,
    userName,
    userTitle
  );

  res.status(201).json({ success: true, data: acknowledgement });
});

// Get departments for public risk form (no auth required, but tied to volunteer action token)
export const getPublicDepartments = asyncHandler(async (req, res) => {
  const { token } = req.params;
  
  // Resolve the volunteer action token to get org_id
  const tokenDoc = await resolveVolunteerActionToken(token, 'risk');
  if (!tokenDoc) {
    throw new AppError('Invalid or expired volunteer action link', 401, 'INVALID_TOKEN');
  }

  const orgId = tokenDoc.org_id;
  const tenantDb = await getTenantConnection(orgId);
  
  // Query departments from tenant DB
  const departments = await tenantDb.collection('departments')
    .find({ is_active: true })
    .project({ name: 1, _id: 1 })
    .toArray();

  res.json({
    success: true,
    data: departments || [],
  });
});

export const submitVolunteerComplaint = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { tokenDoc, tenantDb, volunteer, org } = await getVolunteerContextFromToken(token, 'complaint');
  const complaintRepo = new ComplaintRepository(tenantDb);

  // Merge provided data with volunteer defaults for name/email
  const complainant_name = req.body.complainant_name || [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' ');
  const complainant_email = req.body.complainant_email || volunteer.email;
  const complainant_occupation = req.body.complainant_occupation || 'Volunteer';

  const complaint = await complaintRepo.create({
    org_id: org._id,
    complainant_name,
    complainant_email,
    complainant_occupation,
    complaint_title: req.body.complaint_title,
    description: req.body.description,
    category: req.body.category || null,
    submit_anonymously: req.body.submit_anonymously || false,
    submission_method: 'public_link',
    status: 'new',
    workflow_stage: 'admin_triage',
    priority: 'medium',
    dept_head_approval_decision: 'pending',
    admin_approval_decision: 'pending',
    // Include attachments if provided (full complaint form)
    attachments: Array.isArray(req.body.attachments)
      ? req.body.attachments.map((attachment) => ({
          filename: attachment?.filename || '',
          size: attachment?.size || '',
          mime: attachment?.mime || '',
          data_url: attachment?.data_url || '',
          uploaded_at: attachment?.uploaded_at ? new Date(attachment.uploaded_at) : new Date(),
          uploaded_by: null,
        }))
      : [],
    volunteer_submission: {
      source: 'volunteer_link',
      board_member_id: volunteer._id,
      name: [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' '),
      email: volunteer.email,
      action_token: token,
      action_type: tokenDoc.action_type,
      submitted_at: new Date(),
    },
    trail: [
      {
        at: new Date(),
        actor_user_id: null,
        action: 'created_by_volunteer',
        details: { board_member_id: String(volunteer._id), action_token: token },
      },
    ],
  });

  await markVolunteerActionTokenUsed(token);
  res.json({ success: true, data: complaint });
});

export const submitVolunteerRisk = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { tokenDoc, tenantDb, volunteer, org } = await getVolunteerContextFromToken(token, 'risk');
  const riskRepo = new RiskRepository(tenantDb);

  const risk = await riskRepo.create({
    org_id: org._id,
    title: req.body.title,
    description: req.body.description || '',
    category: req.body.category || 'Operational',
    department_id: req.body.department_id || null,
    existing_controls: req.body.existing_controls || '',
    next_review_date: req.body.next_review_date || null,
    status: 'pending',
    // Default risk assessment values (set to low, will be updated by department head)
    // likelihood and consequence are Numbers (1-5), inherent_risk_level is lowercase enum
    inherent_risk_level: 'low',
    inherent_risk_score: 1,
    likelihood: 1,
    consequence: 1,
    attachments: Array.isArray(req.body.attachments)
      ? req.body.attachments.map((attachment) => ({
          filename: attachment?.filename || '',
          size: attachment?.size || '',
          mime: attachment?.mime || '',
          data_url: attachment?.data_url || '',
          uploaded_at: attachment?.uploaded_at ? new Date(attachment.uploaded_at) : new Date(),
          uploaded_by: null,
        }))
      : [],
    volunteer_submission: {
      source: 'volunteer_link',
      board_member_id: volunteer._id,
      name: [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' '),
      email: volunteer.email,
      action_token: token,
      action_type: tokenDoc.action_type,
      submitted_at: new Date(),
    },
    metadata: {
      submitted_by_type: 'volunteer',
    },
  });

  await markVolunteerActionTokenUsed(token);
  res.json({ success: true, data: risk });
});

export const submitVolunteerCoi = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { tokenDoc, tenantDb, volunteer, org } = await getVolunteerContextFromToken(token, 'coi');
  const coiRepo = new CoiRequestRepository(tenantDb);

  const coi = await coiRepo.create({
    org_id: org._id,
    parent_approval_request_id: null,
    parent_step_index: null,
    parent_entity_id: null,
    parent_entity_type: null,
    coi_reason: req.body.coi_reason,
    submission_source: 'external',
    is_external: true,
    external_submitter: {
      name: [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' '),
      email: volunteer.email,
      phone: req.body.phone || '',
    },
    conflict_person_name: req.body.conflict_person_name,
    conflict_person_details: req.body.conflict_person_details,
    status: 'pending',
    approval_steps: [],
    submitted_by: null,
    volunteer_submission: {
      source: 'volunteer_link',
      board_member_id: volunteer._id,
      name: [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' '),
      email: volunteer.email,
      action_token: token,
      action_type: tokenDoc.action_type,
      submitted_at: new Date(),
    },
  });

  await markVolunteerActionTokenUsed(token);
  res.json({ success: true, data: coi });
});

export const regenerateVolunteerActionLinks = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() },
    });
  }

  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const volunteer = await boardMemberRepo.findById(boardMemberId);
  if (!volunteer) throw new AppError('Volunteer not found', 404, 'NOT_FOUND');
  if (!volunteer.is_volunteer) throw new AppError('Board member is not marked as volunteer', 400, 'NOT_VOLUNTEER');
  if (!volunteer.email) throw new AppError('Volunteer email is required to generate links', 400, 'VOLUNTEER_EMAIL_REQUIRED');

  // Create new tokens for all three action types
  const [complaintDoc, riskDoc, coiDoc] = await Promise.all([
    createVolunteerActionToken({
      orgId,
      boardMemberId,
      actionType: 'complaint',
      email: volunteer.email,
    }),
    createVolunteerActionToken({
      orgId,
      boardMemberId,
      actionType: 'risk',
      email: volunteer.email,
    }),
    createVolunteerActionToken({
      orgId,
      boardMemberId,
      actionType: 'coi',
      email: volunteer.email,
    }),
  ]);

  // Update the volunteer record with new action links
  const actionLinks = {
    complaint: `${FRONTEND_URL}/public/volunteer/complaint/${complaintDoc.token}`,
    risk: `${FRONTEND_URL}/public/volunteer/risk/${riskDoc.token}`,
    coi: `${FRONTEND_URL}/public/volunteer/coi/${coiDoc.token}`,
    generated_at: new Date(),
  };

  await boardMemberRepo.updateById(boardMemberId, {
    volunteer_action_links: actionLinks,
  });

  res.json({
    success: true,
    data: {
      volunteer_action_links: actionLinks,
    },
  });
});

export const resendVolunteerActionLinks = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() },
    });
  }

  const orgId = req.orgId;
  const { boardMemberId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  const volunteer = await boardMemberRepo.findById(boardMemberId);
  if (!volunteer) throw new AppError('Volunteer not found', 404, 'NOT_FOUND');
  if (!volunteer.is_volunteer) throw new AppError('Board member is not marked as volunteer', 400, 'NOT_VOLUNTEER');
  if (!volunteer.email) throw new AppError('Volunteer email is required to send links', 400, 'VOLUNTEER_EMAIL_REQUIRED');

  let links = volunteer.volunteer_action_links || null;
  const hasAnyLink =
    !!String(links?.complaint || '').trim() || !!String(links?.risk || '').trim() || !!String(links?.coi || '').trim();

  if (!hasAnyLink) {
    // Ensure links exist before sending.
    const frontendUrl = process.env.FRONTEND_URL || FRONTEND_URL;
    const [complaintDoc, riskDoc, coiDoc] = await Promise.all([
      createVolunteerActionToken({ orgId, boardMemberId, actionType: 'complaint', email: volunteer.email }),
      createVolunteerActionToken({ orgId, boardMemberId, actionType: 'risk', email: volunteer.email }),
      createVolunteerActionToken({ orgId, boardMemberId, actionType: 'coi', email: volunteer.email }),
    ]);
    links = {
      complaint: `${frontendUrl}/public/volunteer/complaint/${complaintDoc.token}`,
      risk: `${frontendUrl}/public/volunteer/risk/${riskDoc.token}`,
      coi: `${frontendUrl}/public/volunteer/coi/${coiDoc.token}`,
      generated_at: new Date(),
    };
    await boardMemberRepo.update(boardMemberId, { volunteer_action_links: links });
  }

  const recipientName = [volunteer.given_names, volunteer.family_name].filter(Boolean).join(' ').trim() || 'Volunteer';
  await emailService.sendVolunteerActionLinksEmail({
    to: volunteer.email,
    recipientName,
    organizationName: org?.name || 'Your Organization',
    volunteerActionLinks: links,
  });

  res.json({ success: true, data: { volunteer_action_links: links } });
});

export const getVolunteerSubmissionsStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);

  const [complaintStats, riskStats, coiStats] = await Promise.all([
    (async () => {
      const col = tenantDb.collection('complaints');
      const count = await col.countDocuments({ 'volunteer_submission.source': 'volunteer_link' });
      return count;
    })(),
    (async () => {
      const col = tenantDb.collection('risks');
      const count = await col.countDocuments({ 'volunteer_submission.source': 'volunteer_link' });
      return count;
    })(),
    (async () => {
      const col = tenantDb.collection('coi_requests');
      const count = await col.countDocuments({ 'volunteer_submission.source': 'volunteer_link' });
      return count;
    })(),
  ]);

  const total = complaintStats + riskStats + coiStats;

  res.json({
    success: true,
    data: {
      total,
      complaints: complaintStats,
      risks: riskStats,
      cois: coiStats,
    },
  });
});
