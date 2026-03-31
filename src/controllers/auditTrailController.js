/**
 * Audit Trail Controller
 *
 * Aggregates workflow actions across approvals and COI requests.
 */

import mongoose from 'mongoose';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import policySchema from '../db/schemas/platform/policySchema.js';
import expenseSchema from '../db/schemas/platform/expenseSchema.js';
import complaintSchema from '../db/schemas/platform/complaintSchema.js';
import riskSchema from '../db/schemas/platform/riskSchema.js';
import documentSchema from '../db/schemas/platform/documentSchema.js';
import legalDocumentSchema from '../db/schemas/platform/legalDocumentSchema.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';
import policyAcknowledgementSchema from '../db/schemas/platform/policyAcknowledgementSchema.js';
import trainingCompletionSchema from '../db/schemas/platform/trainingCompletionSchema.js';
import trainingEnrollmentSchema from '../db/schemas/platform/trainingEnrollmentSchema.js';
import trainingProgramSchema from '../db/schemas/platform/trainingProgramSchema.js';
import donorSchema from '../db/schemas/platform/donorSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import assetSchema from '../db/schemas/platform/assetSchema.js';
import supportTicketSchema from '../db/schemas/platform/supportTicketSchema.js';
import approvalThresholdSchema from '../db/schemas/platform/approvalThresholdSchema.js';
import { decrypt, isEncrypted } from '../utils/encryption.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { decryptBoardMemberFields } from '../utils/decryptBoardMember.js';

const toName = (user) => {
  if (!user) return '—';
  const keyHex = getMasterKeyHex();
  const first = (keyHex && user.first_name && typeof user.first_name === 'string' && isEncrypted(user.first_name))
    ? (() => { try { return decrypt(user.first_name, keyHex); } catch (_) { return ''; } })()
    : (user.first_name || '');
  const last = (keyHex && user.last_name && typeof user.last_name === 'string' && isEncrypted(user.last_name))
    ? (() => { try { return decrypt(user.last_name, keyHex); } catch (_) { return ''; } })()
    : (user.last_name || '');
  const email = (keyHex && user.email && typeof user.email === 'string' && isEncrypted(user.email))
    ? (() => { try { return decrypt(user.email, keyHex); } catch (_) { return ''; } })()
    : (user.email || '');
  const name = `${first} ${last}`.trim();
  return name || email || '—';
};

const toRole = (user) => {
  if (!user) return null;
  if (user.is_org_owner) return 'Admin';
  if (user.is_auditor === true) return 'Auditor';
  return user.role || user.position || null;
};

const normalizeEvent = (event) => ({
  id: event.id,
  timestamp: event.timestamp,
  actor: event.actor,
  action: event.action,
  module: event.module,
  request_type: event.request_type,
  request_id: event.request_id,
  details: event.details || null,
  step: event.step || null,
  source: event.source
});

/** True if any primitive in details (shallow + one nested object level) equals rid — catches policy_id, risk_id, nested trail details, etc. */
function detailsContainsId(details, rid, depth = 0) {
  if (!details || typeof details !== 'object' || depth > 2) return false;
  for (const v of Object.values(details)) {
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if (detailsContainsId(v, rid, depth + 1)) return true;
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (item != null && String(item) === rid) return true;
        if (item && typeof item === 'object' && !(item instanceof Date) && detailsContainsId(item, rid, depth + 1)) return true;
      }
    } else if (String(v) === rid) return true;
  }
  return false;
}

/**
 * Same request grouping as frontend (AuditTrailDetailPage): COI rolls up to parent approval id when present.
 * All ids normalized to strings so ObjectId vs string Map lookups match Mongoose lean() output.
 */
function filterEventsByRequestId(allEvents, requestId) {
  const rid = String(requestId).trim();
  if (!rid) return [];

  const coiParentMap = new Map();
  allEvents.forEach((e) => {
    if ((e.module === 'coi' || e.request_type === 'coi') && e.details?.parent_approval_request_id) {
      const cid = e.request_id != null ? String(e.request_id) : '';
      if (cid) {
        coiParentMap.set(cid, String(e.details.parent_approval_request_id));
      }
    }
  });

  const matches = (e) => {
    const reqStr = e.request_id != null ? String(e.request_id) : '';
    const parentFromMap = coiParentMap.get(reqStr);
    const key = parentFromMap || reqStr || (e.id != null ? String(e.id) : '');
    if (key && String(key) === rid) return true;
    // Parent approval id on COI / nested details (download by approval id)
    if (String(e.details?.parent_approval_request_id || '') === rid) return true;
    // Entity id on approval-backed events (some UIs pass entity id)
    if (String(e.details?.entity_id || '') === rid) return true;
    // Linked ids inside details (complaint trail, risk_id, policy_id on acks, etc.)
    if (detailsContainsId(e.details, rid)) return true;
    // Composite event ids: policy-created-<mongoId>, document-uploaded-<mongoId>, etc.
    if (e.id && typeof e.id === 'string' && e.id.endsWith(rid)) return true;
    return false;
  };

  const out = allEvents.filter(matches);
  return out.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}


async function buildAuditTrailEventsArray(tenantDb, org, tenantOrgKey = null) {
  // Ensure models for entity lookups
  const Policy = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
  const Expense = tenantDb.models.Expense || tenantDb.model('Expense', expenseSchema);
  const Complaint = tenantDb.models.Complaint || tenantDb.model('Complaint', complaintSchema);
  const Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);
  const Document = tenantDb.models.Document || tenantDb.model('Document', documentSchema);
  const LegalDocument = tenantDb.models.LegalDocument || tenantDb.model('LegalDocument', legalDocumentSchema);
  const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const ApprovalMatrix = tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
  const PolicyAcknowledgement = tenantDb.models.PolicyAcknowledgement || tenantDb.model('PolicyAcknowledgement', policyAcknowledgementSchema);
  const TrainingCompletion = tenantDb.models.TrainingCompletion || tenantDb.model('TrainingCompletion', trainingCompletionSchema);
  const TrainingEnrollment = tenantDb.models.TrainingEnrollment || tenantDb.model('TrainingEnrollment', trainingEnrollmentSchema);
  const TrainingProgram = tenantDb.models.TrainingProgram || tenantDb.model('TrainingProgram', trainingProgramSchema);
  const Donor = tenantDb.models.Donor || tenantDb.model('Donor', donorSchema);
  const FundingAgreement = tenantDb.models.FundingAgreement || tenantDb.model('FundingAgreement', fundingAgreementSchema);
  const ProjectRegister = tenantDb.models.ProjectRegister || tenantDb.model('ProjectRegister', projectRegisterSchema);
  const Asset = tenantDb.models.Asset || tenantDb.model('Asset', assetSchema);
  const SupportTicket = tenantDb.models.SupportTicket || tenantDb.model('SupportTicket', supportTicketSchema);
  const ApprovalThreshold = tenantDb.models.ApprovalThreshold || tenantDb.model('ApprovalThreshold', approvalThresholdSchema);
  // Register User model (tenant)
  new UserRepository(tenantDb);
  const User = tenantDb.models.User;

  const approvalRepo = new ApprovalRequestRepository(tenantDb);
  // Use model directly to populate rejection reviews
  const ApprovalRequest = tenantDb.models.ApprovalRequest;
  const approvals = await ApprovalRequest.find({ org_id: org._id })
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
    .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
    .sort({ created_at: -1 })
    .lean();

  const coiRepo = new CoiRequestRepository(tenantDb);
  const CoiRequest = tenantDb.models.CoiRequest;
  const coiRequests = await CoiRequest.find({ org_id: org._id })
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .sort({ created_at: -1 })
    .lean();

  const events = [];

  const policyIds = approvals
    .filter((reqDoc) => reqDoc.entity_type === 'policy' && reqDoc.entity_id)
    .map((reqDoc) => reqDoc.entity_id);
  const expenseIds = approvals
    .filter((reqDoc) => reqDoc.entity_type === 'expense' && reqDoc.entity_id)
    .map((reqDoc) => reqDoc.entity_id);
  const riskIds = approvals
    .filter((reqDoc) => reqDoc.entity_type === 'risk' && reqDoc.entity_id)
    .map((reqDoc) => reqDoc.entity_id);

  const [policies, expenses, risks] = await Promise.all([
    policyIds.length
      ? Policy.find({ _id: { $in: policyIds } })
          .select('title category version status')
          .lean()
      : Promise.resolve([]),
    expenseIds.length
      ? Expense.find({ _id: { $in: expenseIds } })
          .select('amount category vendor_name description status')
          .lean()
      : Promise.resolve([]),
    riskIds.length
      ? Risk.find({ _id: { $in: riskIds } })
          .select('title category status')
          .lean()
      : Promise.resolve([])
  ]);

  const policyMap = new Map(policies.map((item) => [item._id?.toString(), item]));
  const expenseMap = new Map(expenses.map((item) => [item._id?.toString(), item]));
  const riskMap = new Map(risks.map((item) => [item._id?.toString(), item]));

  approvals.forEach((reqDoc) => {
    const requestId = reqDoc._id?.toString();
    const requestType = reqDoc.request_type;
    const module = reqDoc.entity_type || reqDoc.request_type;
    const entityId = reqDoc.entity_id?.toString();
    const policy = entityId ? policyMap.get(entityId) : null;
    const expense = entityId ? expenseMap.get(entityId) : null;
    const risk = entityId ? riskMap.get(entityId) : null;

    const submittedAction = module === 'policy'
      ? 'Policy update submitted'
      : module === 'expense'
      ? 'Expense submitted for approval'
      : module === 'risk'
      ? 'Risk submitted for approval'
      : 'Submitted approval request';

    // Submitted event
    events.push(normalizeEvent({
      id: `approval-submitted-${requestId}`,
      timestamp: reqDoc.created_at,
      actor: {
        id: reqDoc.submitted_by?._id?.toString(),
        name: toName(reqDoc.submitted_by),
        role: toRole(reqDoc.submitted_by)
      },
      action: submittedAction,
      module,
      request_type: requestType,
      request_id: requestId,
      details: {
        status: reqDoc.status,
        approval_type: reqDoc.approval_type,
        entity_id: entityId || null,
        entity_title: policy?.title || expense?.description || risk?.title || null,
        entity_category: policy?.category || expense?.category || risk?.category || null,
        entity_version: policy?.version || null,
        amount: expense?.amount ?? reqDoc.amount ?? null,
        vendor: expense?.vendor_name || null
      },
      source: 'approval'
    }));

    if (reqDoc.status === 'paused_for_coi' && reqDoc.paused_at) {
      events.push(normalizeEvent({
        id: `approval-coi-paused-${requestId}`,
        timestamp: reqDoc.paused_at,
        actor: {
          id: reqDoc.submitted_by?._id?.toString(),
          name: toName(reqDoc.submitted_by),
          role: toRole(reqDoc.submitted_by)
        },
        action: 'Paused for COI',
        module,
        request_type: requestType,
        request_id: requestId,
        details: {
          coi_request_id: reqDoc.current_coi_request_id || null
        },
        source: 'approval'
      }));
    }

    (reqDoc.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `approval-step-approved-${requestId}-${idx}`,
          timestamp: step.approved_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Approved request',
          module,
          request_type: requestType,
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            comments: step.comments || null,
            acknowledgement_note: step.acknowledgement_note || null,
            acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null
          },
          source: 'approval'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `approval-step-rejected-${requestId}-${idx}`,
          timestamp: step.rejected_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Rejected request',
          module,
          request_type: requestType,
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            reason: step.rejection_reason || step.comments || null,
            acknowledgement_note: step.acknowledgement_note || null,
            acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null
          },
          source: 'approval'
        }));
      }
    });

    (reqDoc.rejection_reviews || []).forEach((review, idx) => {
      events.push(normalizeEvent({
        id: `rejection-forwarded-${requestId}-${idx}`,
        timestamp: review.created_at,
        actor: {
          id: review.rejected_by?._id?.toString(),
          name: toName(review.rejected_by),
          role: toRole(review.rejected_by)
        },
        action: 'Forwarded rejection',
        module,
        request_type: requestType,
        request_id: requestId,
        details: {
          forwarded_to: toName(review.forwarded_to),
          comments: review.rejection_comments || null,
          step_index: review.step_index
        },
        source: 'rejection_review'
      }));

      if (review.review_action && review.reviewed_at) {
        events.push(normalizeEvent({
          id: `rejection-reviewed-${requestId}-${idx}`,
          timestamp: review.reviewed_at,
          actor: {
            id: review.forwarded_to?._id?.toString(),
            name: toName(review.forwarded_to),
            role: toRole(review.forwarded_to)
          },
          action: review.review_action === 'accept_rejection' ? 'Rejection accepted' : 'Rejection declined',
          module,
          request_type: requestType,
          request_id: requestId,
          details: {
            review_comments: review.review_comments || null
          },
          source: 'rejection_review'
        }));
      }
    });
  });

  coiRequests.forEach((coi) => {
    const requestId = coi._id?.toString();
    const module = 'coi';

    events.push(normalizeEvent({
      id: `coi-submitted-${requestId}`,
      timestamp: coi.created_at,
      actor: {
        id: coi.submitted_by?._id?.toString(),
        name: toName(coi.submitted_by),
        role: toRole(coi.submitted_by)
      },
      action: 'Submitted COI',
      module,
      request_type: 'coi',
      request_id: requestId,
      details: {
        reason: coi.coi_reason || null,
        parent_approval_request_id: coi.parent_approval_request_id?.toString() || null
      },
      source: 'coi'
    }));

    (coi.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `coi-step-approved-${requestId}-${idx}`,
          timestamp: step.approved_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Approved COI step',
          module,
          request_type: 'coi',
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            comments: step.comments || null
          },
          source: 'coi'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `coi-step-rejected-${requestId}-${idx}`,
          timestamp: step.rejected_at,
          actor: {
            id: step.approver_user_id?._id?.toString() || step.approver_user_id?.toString(),
            name: toName(step.approver_user_id),
            role: step.approver_position_id?.title || toRole(step.approver_user_id)
          },
          action: 'Rejected COI step',
          module,
          request_type: 'coi',
          request_id: requestId,
          step: {
            index: idx,
            level: step.level,
            position: step.approver_position_id?.title || null
          },
          details: {
            reason: step.rejection_reason || step.comments || null
          },
          source: 'coi'
        }));
      }
    });
  });

  // Complaint workflow events (prefer explicit complaint.trail; fallback to derived resolution events)
  const complaints = await Complaint.find({
    org_id: org._id,
    $or: [
      { trail: { $exists: true, $ne: [] } },
      { 'resolution_details.root_cause': { $exists: true, $ne: '' } },
      { 'resolution_details.risk_linked_at': { $exists: true } },
      { 'resolution_details.training_linked_at': { $exists: true } },
      { status: 'resolved' }
    ]
  })
    .populate('assigned_to', 'first_name last_name email is_org_owner role position')
    .populate('trail.actor_user_id', 'first_name last_name email is_org_owner role position')
    .lean();

  const complaintRiskIds = complaints
    .map((item) => item.linked_risk_id?.toString())
    .filter(Boolean);
  const complaintRiskMap = complaintRiskIds.length
    ? new Map(
        (await Risk.find({ _id: { $in: complaintRiskIds } })
          .select('title')
          .lean()
        ).map((item) => [item._id?.toString(), item])
      )
    : new Map();

  const complaintActionLabel = (a) => {
    const map = {
      created: 'Complaint created',
      admin_triage_completed: 'Admin review completed',
      dept_head_completed: 'Department head completed',
      major_flag_set: 'Major flag updated',
      board_signoff_selected: 'Board approval selected',
      escalated: 'Escalated',
      deescalated: 'De-escalated',
      resolution_details_saved: 'Resolution details saved',
      risk_linked: 'Risk linked to complaint',
      training_linked: 'Training linked to complaint',
      signed_off: 'Board approval completed',
      resolved: 'Complaint resolved',
    };
    return map[a] || a || 'Complaint updated';
  };

  complaints.forEach((complaint) => {
    const complaintId = complaint._id?.toString();
    const resolutionDetails = complaint.resolution_details || {};

    if (Array.isArray(complaint.trail) && complaint.trail.length > 0) {
      complaint.trail.forEach((t, idx) => {
        const actorUser = t?.actor_user_id;
        events.push(normalizeEvent({
          id: `complaint-trail-${complaintId}-${idx}`,
          timestamp: t?.at || complaint.updated_at,
          actor: {
            id: actorUser?._id?.toString() || actorUser?.toString?.(),
            name: toName(actorUser),
            role: toRole(actorUser)
          },
          action: complaintActionLabel(t?.action),
          module: 'complaint',
          request_type: 'complaint',
          request_id: complaintId,
          details: {
            complaint_title: complaint.complaint_title,
            ...(t?.details || {})
          },
          source: 'complaint'
        }));
      });
      return;
    }

    // Fallback (older records without trail)
    const actorUser = complaint.assigned_to;
    const actor = {
      id: actorUser?._id?.toString(),
      name: toName(actorUser),
      role: toRole(actorUser)
    };

    if (resolutionDetails.root_cause) {
      events.push(normalizeEvent({
        id: `complaint-resolution-${complaintId}`,
        timestamp: resolutionDetails.completed_at || complaint.updated_at,
        actor,
        action: 'Resolution details saved',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title
        },
        source: 'complaint'
      }));
    }

    if (complaint.linked_risk_id) {
      const riskTitle = complaintRiskMap.get(complaint.linked_risk_id?.toString())?.title || null;
      events.push(normalizeEvent({
        id: `complaint-risk-${complaintId}`,
        timestamp: resolutionDetails.risk_linked_at || complaint.updated_at,
        actor,
        action: 'Risk linked to complaint',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title,
          risk_title: riskTitle,
          risk_id: complaint.linked_risk_id?.toString()
        },
        source: 'complaint'
      }));
    }

    if (complaint.linked_training_id) {
      events.push(normalizeEvent({
        id: `complaint-training-${complaintId}`,
        timestamp: resolutionDetails.training_linked_at || complaint.updated_at,
        actor,
        action: 'Training linked to complaint',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title,
          training_title: complaint.training_attachment?.training_title || null,
          training_id: complaint.linked_training_id?.toString()
        },
        source: 'complaint'
      }));
    }

    if (complaint.status === 'resolved') {
      events.push(normalizeEvent({
        id: `complaint-resolved-${complaintId}`,
        timestamp: resolutionDetails.resolved_at || complaint.updated_at,
        actor,
        action: 'Complaint resolved',
        module: 'complaint',
        request_type: 'complaint',
        request_id: complaintId,
        details: {
          complaint_title: complaint.complaint_title
        },
        source: 'complaint'
      }));
    }
  });

  // Additional immutable-style operational events for weekly compliance reporting.
  const [governingDocs, legalDocs, boardMembers, workflows, thresholds, users, standaloneRisks, policyAcknowledgements, completedTrainingCompletions, allPolicies, allTrainings, allExpenses, allDonors, allFundingAgreements, allProjects, allAssets, allSupportTickets] = await Promise.all([
    Document.find({ org_id: org._id, category: 'governing_document' })
      .populate('uploaded_by', 'first_name last_name email is_org_owner role position')
      .select('title document_type status createdAt updatedAt uploaded_by')
      .lean(),
    LegalDocument.find({ org_id: org._id })
      .populate('created_by', 'first_name last_name email is_org_owner role position')
      .select('document_name category category_other_text status createdAt updatedAt created_by')
      .lean(),
    BoardMember.find({ org_id: org._id })
      .populate('user_id', 'first_name last_name email is_org_owner role position')
      .select('given_names family_name email position custom_position_title status is_active createdAt updatedAt user_id')
      .lean(),
    ApprovalMatrix.find({ org_id: org._id })
      .populate('revoked_by', 'first_name last_name email is_org_owner role position')
      .populate('created_by', 'first_name last_name email is_org_owner role position')
      .populate('updated_by', 'first_name last_name email is_org_owner role position')
      .select('name workflow_category workflow_type is_active revoked_at createdAt updatedAt revoked_by created_by updated_by')
      .lean(),
    ApprovalThreshold.findOne({ org_id: org._id })
      .populate('updated_by', 'first_name last_name email is_org_owner role position')
      .select('currency tiers created_at updated_at updated_by')
      .lean(),
    User.find({})
      .populate('created_by', 'first_name last_name email is_org_owner role position')
      .select('email first_name last_name status createdAt created_by')
      .sort({ createdAt: -1 })
      .lean(),
    Risk.find({ org_id: org._id })
      .populate('submitted_by', 'first_name last_name email is_org_owner role position')
      .select('title category status createdAt updatedAt submitted_by')
      .lean(),
    PolicyAcknowledgement.find({})
      .select('policy_id user_id user_name user_title acknowledged_at')
      .lean(),
    TrainingCompletion.find({ status: 'completed' })
      .select('enrollment_id completed_at createdAt updatedAt status')
      .lean(),
    Policy.find({ org_id: org._id })
      .populate('uploaded_by', 'first_name last_name email is_org_owner role position')
      .select('title category status createdAt updatedAt uploaded_by')
      .lean(),
    TrainingProgram.find({ org_id: org._id })
      .select('title category status createdAt updatedAt')
      .lean(),
    Expense.find({ org_id: org._id })
      .populate('submitted_by', 'first_name last_name email is_org_owner role position')
      .select('expense_name description category amount status created_at updatedAt submitted_by')
      .lean(),
    Donor.find({ org_id: org._id })
      .select('name donor_type size status createdAt updatedAt')
      .lean(),
    FundingAgreement.find({ org_id: org._id })
      .select('agreement_title agreement_type total_amount status createdAt updatedAt')
      .lean(),
    ProjectRegister.find({ org_id: org._id })
      .select('project_name agreement_title status phase warning createdAt updatedAt')
      .lean(),
    // Assets store org_id as tenant key (req.orgId / org.orgId), not Organization._id — match all shapes
    Asset.find({
      $or: [
        ...(tenantOrgKey ? [{ org_id: tenantOrgKey }] : []),
        ...(org.orgId ? [{ org_id: org.orgId }] : []),
        { org_id: org._id },
        { org_id: String(org._id) }
      ]
    })
      .populate('created_by', 'first_name last_name email is_org_owner role position')
      .select('asset_name category type status created_at updatedAt created_by')
      .lean(),
    SupportTicket.find({ org_id: org._id })
      .select('ticket_number summary category priority status created_at updatedAt reporter')
      .lean()
  ]);

  const policyAcknowledgementPolicyIds = policyAcknowledgements
    .map((item) => item.policy_id?.toString())
    .filter(Boolean);
  const trainingEnrollmentIds = completedTrainingCompletions
    .map((item) => item.enrollment_id?.toString())
    .filter(Boolean);

  const [ackPolicies, trainingEnrollments] = await Promise.all([
    policyAcknowledgementPolicyIds.length
      ? Policy.find({ _id: { $in: policyAcknowledgementPolicyIds } }).select('title category').lean()
      : Promise.resolve([]),
    trainingEnrollmentIds.length
      ? TrainingEnrollment.find({ _id: { $in: trainingEnrollmentIds } })
          .populate('training_program_id', 'title category')
          .populate('board_member_id', 'given_names family_name user_id')
          .select('training_program_id board_member_id')
          .lean()
      : Promise.resolve([])
  ]);

  const ackPolicyMap = new Map(ackPolicies.map((item) => [item._id?.toString(), item]));
  const enrollmentMap = new Map(trainingEnrollments.map((item) => [item._id?.toString(), item]));

  governingDocs.forEach((doc) => {
    const actorUser = doc.uploaded_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    events.push(normalizeEvent({
      id: `governing-doc-created-${doc._id}`,
      timestamp: doc.createdAt,
      actor,
      action: 'Governing document added',
      module: 'governing_document',
      request_type: 'governing_document',
      request_id: doc._id?.toString(),
      details: { title: doc.title || null, type: doc.document_type || null, status: doc.status || null },
      source: 'document'
    }));
    if (doc.updatedAt && new Date(doc.updatedAt).getTime() - new Date(doc.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `governing-doc-updated-${doc._id}`,
        timestamp: doc.updatedAt,
        actor,
        action: 'Governing document updated',
        module: 'governing_document',
        request_type: 'governing_document',
        request_id: doc._id?.toString(),
        details: { title: doc.title || null, type: doc.document_type || null, status: doc.status || null },
        source: 'document'
      }));
    }
  });

  legalDocs.forEach((doc) => {
    const actorUser = doc.created_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    const category = doc.category === 'other' ? (doc.category_other_text || 'Other') : doc.category;
    events.push(normalizeEvent({
      id: `legal-doc-created-${doc._id}`,
      timestamp: doc.createdAt,
      actor,
      action: 'Legal document added',
      module: 'legal_document',
      request_type: 'legal_document',
      request_id: doc._id?.toString(),
      details: { title: doc.document_name || null, category: category || null, status: doc.status || null },
      source: 'legal_document'
    }));
    if (doc.updatedAt && new Date(doc.updatedAt).getTime() - new Date(doc.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `legal-doc-updated-${doc._id}`,
        timestamp: doc.updatedAt,
        actor,
        action: 'Legal document updated',
        module: 'legal_document',
        request_type: 'legal_document',
        request_id: doc._id?.toString(),
        details: { title: doc.document_name || null, category: category || null, status: doc.status || null },
        source: 'legal_document'
      }));
    }
  });

  boardMembers.forEach((person) => {
    decryptBoardMemberFields(person, getMasterKeyHex());
    const actorUser = person.user_id || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    const personName = [person.given_names, person.family_name].filter(Boolean).join(' ').trim() || 'Responsible person';
    const personEmail = person.email || null;
    const personPosition = person.custom_position_title || person.position || null;
    events.push(normalizeEvent({
      id: `person-added-${person._id}`,
      timestamp: person.createdAt,
      actor,
      action: 'Responsible person added',
      module: 'responsible_people',
      request_type: 'responsible_people',
      request_id: person._id?.toString(),
      details: { person_name: personName, person_email: personEmail, position: personPosition, status: person.status || null },
      source: 'responsible_people'
    }));
    const removed = person.status === 'removed' || person.status === 'resigned' || person.is_active === false;
    if (removed && person.updatedAt) {
      events.push(normalizeEvent({
        id: `person-removed-${person._id}`,
        timestamp: person.updatedAt,
        actor,
        action: 'Responsible person removed',
        module: 'responsible_people',
        request_type: 'responsible_people',
        request_id: person._id?.toString(),
        details: { person_name: personName, person_email: personEmail, position: personPosition, status: person.status || null },
        source: 'responsible_people'
      }));
    }
  });

  workflows.forEach((wf) => {
    const createdUser = wf.created_by || null;
    const updatedUser = wf.updated_by || null;
    const revokedUser = wf.revoked_by || null;
    const createdActor = { id: createdUser?._id?.toString() || null, name: toName(createdUser), role: toRole(createdUser) };
    const updatedActor = { id: updatedUser?._id?.toString() || null, name: toName(updatedUser), role: toRole(updatedUser) };
    const revokedActor = { id: revokedUser?._id?.toString() || null, name: toName(revokedUser), role: toRole(revokedUser) };

    const wfDetails = {
      workflow_name: wf.name || null,
      category: wf.workflow_category || null,
      workflow_type: wf.workflow_type || null,
      active: wf.is_active
    };
    events.push(normalizeEvent({
      id: `workflow-created-${wf._id}`,
      timestamp: wf.createdAt,
      actor: createdUser ? createdActor : { id: null, name: 'System', role: null },
      action: 'Workflow created',
      module: 'approval_workflow',
      request_type: 'approval_workflow',
      request_id: wf._id?.toString(),
      details: wfDetails,
      source: 'approval_workflow'
    }));

    // Updated (non-revocation) — only if there is a meaningful update after create.
    if (wf.updatedAt && new Date(wf.updatedAt).getTime() - new Date(wf.createdAt).getTime() > 1000 && !wf.revoked_at) {
      events.push(normalizeEvent({
        id: `workflow-updated-${wf._id}`,
        timestamp: wf.updatedAt,
        actor: updatedUser ? updatedActor : { id: null, name: 'System', role: null },
        action: 'Workflow updated',
        module: 'approval_workflow',
        request_type: 'approval_workflow',
        request_id: wf._id?.toString(),
        details: wfDetails,
        source: 'approval_workflow'
      }));
    }
    if (wf.revoked_at) {
      events.push(normalizeEvent({
        id: `workflow-revoked-${wf._id}`,
        timestamp: wf.revoked_at,
        actor: revokedUser ? revokedActor : { id: null, name: 'System', role: null },
        action: 'Workflow revoked',
        module: 'approval_workflow',
        request_type: 'approval_workflow',
        request_id: wf._id?.toString(),
        details: wfDetails,
        source: 'approval_workflow'
      }));
    }
  });

  // Financial thresholds events (single doc per org)
  if (thresholds) {
    const actorUser = thresholds.updated_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    const details = {
      currency: thresholds.currency || null,
      tiers: Array.isArray(thresholds.tiers) ? thresholds.tiers : null
    };
    events.push(normalizeEvent({
      id: `thresholds-created-${org._id}`,
      timestamp: thresholds.created_at || thresholds.updated_at,
      actor: actorUser ? actor : { id: null, name: 'System', role: null },
      action: 'Financial thresholds created',
      module: 'financial_thresholds',
      request_type: 'financial_thresholds',
      request_id: String(org._id),
      details,
      source: 'approval_thresholds'
    }));
    if (thresholds.updated_at && thresholds.created_at && new Date(thresholds.updated_at).getTime() - new Date(thresholds.created_at).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `thresholds-updated-${org._id}`,
        timestamp: thresholds.updated_at,
        actor: actorUser ? actor : { id: null, name: 'System', role: null },
        action: 'Financial thresholds updated',
        module: 'financial_thresholds',
        request_type: 'financial_thresholds',
        request_id: String(org._id),
        details,
        source: 'approval_thresholds'
      }));
    }
  }

  // New users added (team members)
  (users || []).forEach((u) => {
    const actorUser = u.created_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    const userId = u._id?.toString();
    events.push(normalizeEvent({
      id: `user-created-${userId}`,
      timestamp: u.createdAt,
      actor: actorUser ? actor : { id: null, name: 'System', role: null },
      action: 'User added',
      module: 'users',
      request_type: 'user',
      request_id: userId,
      details: {
        user_id: userId,
        email: u.email || null,
        first_name: u.first_name || null,
        last_name: u.last_name || null,
        status: u.status || null
      },
      source: 'user'
    }));
  });

  standaloneRisks.forEach((risk) => {
    const actorUser = risk.submitted_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    events.push(normalizeEvent({
      id: `risk-created-${risk._id}`,
      timestamp: risk.createdAt,
      actor,
      action: 'Risk created',
      module: 'risk',
      request_type: 'risk',
      request_id: risk._id?.toString(),
      details: { title: risk.title || null, category: risk.category || null, status: risk.status || null },
      source: 'risk'
    }));
  });

  policyAcknowledgements.forEach((ack) => {
    const policy = ackPolicyMap.get(ack.policy_id?.toString());
    events.push(normalizeEvent({
      id: `policy-ack-${ack._id}`,
      timestamp: ack.acknowledged_at || ack.updatedAt || ack.createdAt,
      actor: {
        id: ack.user_id?.toString() || null,
        name: ack.user_name || 'Policy reader',
        role: ack.user_title || null
      },
      action: 'Policy acknowledged',
      module: 'policy',
      request_type: 'policy_acknowledgement',
      request_id: ack._id?.toString(),
      details: {
        title: policy?.title || null,
        category: policy?.category || null,
        policy_id: ack.policy_id?.toString() || null
      },
      source: 'policy_acknowledgement'
    }));
  });

  completedTrainingCompletions.forEach((completion) => {
    const enrollment = enrollmentMap.get(completion.enrollment_id?.toString());
    const boardMember = enrollment?.board_member_id;
    const actorName = boardMember
      ? `${boardMember.given_names || ''} ${boardMember.family_name || ''}`.trim() || 'Training participant'
      : 'Training participant';
    events.push(normalizeEvent({
      id: `training-completed-${completion._id}`,
      timestamp: completion.completed_at || completion.updatedAt || completion.createdAt,
      actor: {
        id: boardMember?.user_id?.toString() || null,
        name: actorName,
        role: null
      },
      action: 'Training completed',
      module: 'training',
      request_type: 'training_completion',
      request_id: completion._id?.toString(),
      details: {
        title: enrollment?.training_program_id?.title || null,
        category: enrollment?.training_program_id?.category || null,
        status: completion.status || null
      },
      source: 'training_completion'
    }));
  });

  allPolicies.forEach((policy) => {
    const actorUser = policy.uploaded_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    events.push(normalizeEvent({
      id: `policy-created-${policy._id}`,
      timestamp: policy.createdAt,
      actor,
      action: 'Policy added',
      module: 'policy',
      request_type: 'policy',
      request_id: policy._id?.toString(),
      details: { title: policy.title || null, category: policy.category || null, status: policy.status || null },
      source: 'policy'
    }));
    if (policy.updatedAt && new Date(policy.updatedAt).getTime() - new Date(policy.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `policy-updated-${policy._id}`,
        timestamp: policy.updatedAt,
        actor,
        action: 'Policy updated',
        module: 'policy',
        request_type: 'policy',
        request_id: policy._id?.toString(),
        details: { title: policy.title || null, category: policy.category || null, status: policy.status || null },
        source: 'policy'
      }));
    }
  });

  allTrainings.forEach((training) => {
    events.push(normalizeEvent({
      id: `training-created-${training._id}`,
      timestamp: training.createdAt,
      actor: { id: null, name: 'System', role: null },
      action: 'Training added',
      module: 'training',
      request_type: 'training',
      request_id: training._id?.toString(),
      details: { title: training.title || null, category: training.category || null, status: training.status || null },
      source: 'training'
    }));
    if (training.updatedAt && new Date(training.updatedAt).getTime() - new Date(training.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `training-updated-${training._id}`,
        timestamp: training.updatedAt,
        actor: { id: null, name: 'System', role: null },
        action: 'Training updated',
        module: 'training',
        request_type: 'training',
        request_id: training._id?.toString(),
        details: { title: training.title || null, category: training.category || null, status: training.status || null },
        source: 'training'
      }));
    }
  });

  allExpenses.forEach((expense) => {
    const actorUser = expense.submitted_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    events.push(normalizeEvent({
      id: `expense-created-${expense._id}`,
      timestamp: expense.created_at || expense.createdAt,
      actor,
      action: 'Expense added',
      module: 'finance',
      request_type: 'expense',
      request_id: expense._id?.toString(),
      details: {
        title: expense.expense_name || expense.description || null,
        category: expense.category || null,
        amount: expense.amount ?? null,
        status: expense.status || null
      },
      source: 'expense'
    }));
    if (expense.updatedAt && new Date(expense.updatedAt).getTime() - new Date(expense.created_at || expense.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `expense-updated-${expense._id}`,
        timestamp: expense.updatedAt,
        actor,
        action: 'Expense updated',
        module: 'finance',
        request_type: 'expense',
        request_id: expense._id?.toString(),
        details: {
          title: expense.expense_name || expense.description || null,
          category: expense.category || null,
          amount: expense.amount ?? null,
          status: expense.status || null
        },
        source: 'expense'
      }));
    }
  });

  allDonors.forEach((donor) => {
    events.push(normalizeEvent({
      id: `donor-created-${donor._id}`,
      timestamp: donor.createdAt,
      actor: { id: null, name: 'System', role: null },
      action: 'Donor added',
      module: 'donor',
      request_type: 'donor',
      request_id: donor._id?.toString(),
      details: { title: donor.name || null, type: donor.donor_type || null, status: donor.status || null, category: donor.size || null },
      source: 'donor'
    }));
    if (donor.updatedAt && new Date(donor.updatedAt).getTime() - new Date(donor.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `donor-updated-${donor._id}`,
        timestamp: donor.updatedAt,
        actor: { id: null, name: 'System', role: null },
        action: 'Donor updated',
        module: 'donor',
        request_type: 'donor',
        request_id: donor._id?.toString(),
        details: { title: donor.name || null, type: donor.donor_type || null, status: donor.status || null, category: donor.size || null },
        source: 'donor'
      }));
    }
  });

  allFundingAgreements.forEach((agreement) => {
    events.push(normalizeEvent({
      id: `funding-created-${agreement._id}`,
      timestamp: agreement.createdAt,
      actor: { id: null, name: 'System', role: null },
      action: 'Funding agreement added',
      module: 'funding_agreement',
      request_type: 'funding_agreement',
      request_id: agreement._id?.toString(),
      details: { title: agreement.agreement_title || null, type: agreement.agreement_type || null, amount: agreement.total_amount ?? null, status: agreement.status || null },
      source: 'funding_agreement'
    }));
    if (agreement.updatedAt && new Date(agreement.updatedAt).getTime() - new Date(agreement.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `funding-updated-${agreement._id}`,
        timestamp: agreement.updatedAt,
        actor: { id: null, name: 'System', role: null },
        action: 'Funding agreement updated',
        module: 'funding_agreement',
        request_type: 'funding_agreement',
        request_id: agreement._id?.toString(),
        details: { title: agreement.agreement_title || null, type: agreement.agreement_type || null, amount: agreement.total_amount ?? null, status: agreement.status || null },
        source: 'funding_agreement'
      }));
    }
  });

  allProjects.forEach((project) => {
    events.push(normalizeEvent({
      id: `project-created-${project._id}`,
      timestamp: project.createdAt,
      actor: { id: null, name: 'System', role: null },
      action: 'Project added',
      module: 'project',
      request_type: 'project',
      request_id: project._id?.toString(),
      details: { title: project.project_name || null, category: project.phase || null, status: project.status || null },
      source: 'project'
    }));
    if (project.updatedAt && new Date(project.updatedAt).getTime() - new Date(project.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `project-updated-${project._id}`,
        timestamp: project.updatedAt,
        actor: { id: null, name: 'System', role: null },
        action: 'Project updated',
        module: 'project',
        request_type: 'project',
        request_id: project._id?.toString(),
        details: { title: project.project_name || null, category: project.phase || null, status: project.status || null },
        source: 'project'
      }));
    }
  });

  allAssets.forEach((asset) => {
    const actorUser = asset.created_by || null;
    const actor = { id: actorUser?._id?.toString() || null, name: toName(actorUser), role: toRole(actorUser) };
    events.push(normalizeEvent({
      id: `asset-created-${asset._id}`,
      timestamp: asset.created_at || asset.createdAt,
      actor,
      action: 'Asset added',
      module: 'asset',
      request_type: 'asset',
      request_id: asset._id?.toString(),
      details: {
        title: asset.asset_name || null,
        category: asset.category || null,
        type: asset.type || null,
        status: asset.status || null,
        asset_id: asset._id?.toString() || null
      },
      source: 'asset'
    }));
    if (asset.updatedAt && new Date(asset.updatedAt).getTime() - new Date(asset.created_at || asset.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `asset-updated-${asset._id}`,
        timestamp: asset.updatedAt,
        actor,
        action: 'Asset updated',
        module: 'asset',
        request_type: 'asset',
        request_id: asset._id?.toString(),
        details: {
          title: asset.asset_name || null,
          category: asset.category || null,
          type: asset.type || null,
          status: asset.status || null,
          asset_id: asset._id?.toString() || null
        },
        source: 'asset'
      }));
    }
  });

  allSupportTickets.forEach((ticket) => {
    const actorName = ticket.reporter?.name || ticket.reporter?.email || 'Support requester';
    events.push(normalizeEvent({
      id: `support-ticket-created-${ticket._id}`,
      timestamp: ticket.created_at || ticket.createdAt,
      actor: { id: ticket.reporter?.user_id?.toString() || null, name: actorName, role: null },
      action: 'Support ticket created',
      module: 'support_ticket',
      request_type: 'support_ticket',
      request_id: ticket._id?.toString(),
      details: { title: ticket.summary || null, category: ticket.category || null, status: ticket.status || null, type: ticket.priority || null },
      source: 'support_ticket'
    }));
    if (ticket.updatedAt && new Date(ticket.updatedAt).getTime() - new Date(ticket.created_at || ticket.createdAt).getTime() > 1000) {
      events.push(normalizeEvent({
        id: `support-ticket-updated-${ticket._id}`,
        timestamp: ticket.updatedAt,
        actor: { id: ticket.reporter?.user_id?.toString() || null, name: actorName, role: null },
        action: 'Support ticket updated',
        module: 'support_ticket',
        request_type: 'support_ticket',
        request_id: ticket._id?.toString(),
        details: { title: ticket.summary || null, category: ticket.category || null, status: ticket.status || null, type: ticket.priority || null },
        source: 'support_ticket'
      }));
    }
  });
  return events;
}

export const getAuditTrail = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = req.tenantDb || await getTenantConnection(orgId);

  // Access model:
  // - Admin (org owner) or Auditor: can view all events or filter by selected user
  // - Non-admin: can only view their own actions
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(req.user?.userId);
  const isAdmin = !!user?.is_org_owner || user?.is_auditor === true;
  const requestedUserId = String(req.query?.userId || '').trim();
  const actorFilterUserId = isAdmin
    ? (requestedUserId || null)
    : String(req.user?.userId || '');
  const startDate = req.query?.startDate ? new Date(req.query.startDate) : null;
  const endDate = req.query?.endDate ? new Date(req.query.endDate) : null;
  const hasValidStart = startDate && !Number.isNaN(startDate.getTime());
  const hasValidEnd = endDate && !Number.isNaN(endDate.getTime());
  const moduleFilter = String(req.query?.module || '').trim().toLowerCase();
  // Inclusive end-date for day-based filters
  if (hasValidEnd) endDate.setHours(23, 59, 59, 999);

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const events = await buildAuditTrailEventsArray(tenantDb, org, orgId);

  const sorted = events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const filtered = sorted.filter((event) => {
    const ts = new Date(event.timestamp);
    if (Number.isNaN(ts.getTime())) return false;
    if (hasValidStart && ts < startDate) return false;
    if (hasValidEnd && ts > endDate) return false;
    if (actorFilterUserId) {
      const eventActorId = event.actor?.id ? String(event.actor.id) : '';
      if (eventActorId !== String(actorFilterUserId)) return false;
    }
    if (moduleFilter && String(event.module || '').toLowerCase() !== moduleFilter) return false;
    return true;
  });

  res.json({
    success: true,
    data: filtered
  });
});

/**
 * Download Audit Trail PDF for a single request
 * GET /platform/audit-trail/download/:requestId
 */
export const downloadAuditTrailPDF = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { requestId } = req.params;
  const tenantDb = req.tenantDb || await getTenantConnection(orgId);

  // Admin or Auditor only
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(req.user?.userId);
  if (!user?.is_org_owner && user?.is_auditor !== true) {
    throw new AppError('Only admins or auditors can download audit trail PDFs', 403, 'ADMIN_ONLY');
  }

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const logoUrl = org?.logo_url || process.env.LOGO || '';

  // Register ApprovalRequest / CoiRequest on this tenant connection (same as buildAuditTrailEventsArray)
  new ApprovalRequestRepository(tenantDb);
  new CoiRequestRepository(tenantDb);

  // Ensure models
  const Policy = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
  const Expense = tenantDb.models.Expense || tenantDb.model('Expense', expenseSchema);
  const Complaint = tenantDb.models.Complaint || tenantDb.model('Complaint', complaintSchema);
  const Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);

  // Try to find as an approval request first
  const ApprovalRequest = tenantDb.models.ApprovalRequest;
  let reqDoc = await ApprovalRequest.findById(requestId)
    .populate('submitted_by', 'first_name last_name email is_org_owner')
    .populate('approval_matrix_id', 'name')
    .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
    .populate('approval_steps.approver_position_id', 'title')
    .populate('approval_steps.approver_department_id', 'name')
    .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
    .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
    .lean();

  let source = 'approval';
  let module = '';
  let entityInfo = {};

  if (!reqDoc) {
    // Try COI request
    const CoiRequest = tenantDb.models.CoiRequest;
    reqDoc = await CoiRequest.findById(requestId)
      .populate('submitted_by', 'first_name last_name email is_org_owner')
      .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .lean();
    source = 'coi';
  }

  if (!reqDoc) {
    // Try complaint
    const complaint = await Complaint.findById(requestId)
      .populate('assigned_to', 'first_name last_name email is_org_owner role position')
      .lean();
    if (complaint) {
      reqDoc = complaint;
      source = 'complaint';
    }
  }

  // URL may carry entity id (policy / expense / risk / document / …) while events use approval _id as request_id
  if (!reqDoc && mongoose.Types.ObjectId.isValid(requestId)) {
    reqDoc = await ApprovalRequest.findOne({
      org_id: org._id,
      entity_id: requestId
    })
      .sort({ created_at: -1 })
      .populate('submitted_by', 'first_name last_name email is_org_owner')
      .populate('approval_matrix_id', 'name')
      .populate('approval_steps.approver_user_id', 'first_name last_name email is_org_owner')
      .populate('approval_steps.approver_position_id', 'title')
      .populate('approval_steps.approver_department_id', 'name')
      .populate('rejection_reviews.rejected_by', 'first_name last_name email is_org_owner')
      .populate('rejection_reviews.forwarded_to', 'first_name last_name email is_org_owner')
      .lean();
    if (reqDoc) source = 'approval';
  }

  if (!reqDoc) {
    // Not an approval, COI, or complaint document id — use full audit aggregate + same grouping as UI
    const allEvents = await buildAuditTrailEventsArray(tenantDb, org, orgId);
    const grouped = filterEventsByRequestId(allEvents, requestId);
    if (grouped.length === 0) {
      throw new AppError('Request not found', 404, 'NOT_FOUND');
    }
    const sortedAgg = grouped
      .filter((e) => e.timestamp)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const actorMapAgg = new Map();
    sortedAgg.forEach((e) => {
      if (e.actor?.id && !actorMapAgg.has(e.actor.id)) {
        actorMapAgg.set(e.actor.id, { name: e.actor.name, role: e.actor.role });
      }
    });
    const uniqueActorsAgg = Array.from(actorMapAgg.values());
    const moduleAgg = sortedAgg[0]?.module || sortedAgg.find((e) => e.module)?.module || 'general';
    const entityInfoAgg = {
      title:
        sortedAgg.find((e) => e.details?.entity_title)?.details?.entity_title ||
        sortedAgg.find((e) => e.details?.complaint_title)?.details?.complaint_title ||
        sortedAgg.find((e) => e.details?.title)?.details?.title ||
        null
    };
    const { generateAuditTrailPDF: genPdfAgg } = await import('../services/auditTrailPdfService.js');
    const pdfBufferAgg = await genPdfAgg(
      sortedAgg,
      uniqueActorsAgg,
      entityInfoAgg,
      moduleAgg,
      requestId,
      logoUrl
    );
    const fileNameAgg = `audit_trail_${requestId}_${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileNameAgg}"`);
    res.setHeader('Content-Length', pdfBufferAgg.length);
    return res.send(pdfBufferAgg);
  }

  // Build events for this single request (same logic as getAuditTrail but filtered)
  const events = [];

  if (source === 'approval') {
    module = reqDoc.entity_type || reqDoc.request_type;
    const entityId = reqDoc.entity_id?.toString();

    // Fetch entity details
    if (entityId) {
      if (module === 'policy') {
        const p = await Policy.findById(entityId).select('title category version status').lean();
        if (p) entityInfo = { title: p.title, category: p.category, version: p.version };
      } else if (module === 'expense') {
        const e = await Expense.findById(entityId).select('amount category vendor_name description status').lean();
        if (e) entityInfo = { title: e.description, category: e.category, amount: e.amount, vendor: e.vendor_name };
      } else if (module === 'risk') {
        const r = await Risk.findById(entityId).select('title category status').lean();
        if (r) entityInfo = { title: r.title, category: r.category };
      }
    }

    // Submitted
    events.push(normalizeEvent({
      id: `approval-submitted-${requestId}`,
      timestamp: reqDoc.created_at,
      actor: { id: reqDoc.submitted_by?._id?.toString(), name: toName(reqDoc.submitted_by), role: toRole(reqDoc.submitted_by) },
      action: module === 'policy' ? 'Policy update submitted' : module === 'expense' ? 'Expense submitted for approval' : module === 'risk' ? 'Risk submitted for approval' : 'Submitted approval request',
      module, request_type: reqDoc.request_type, request_id: requestId,
      details: { status: reqDoc.status, approval_type: reqDoc.approval_type, entity_title: entityInfo.title || null, amount: entityInfo.amount || null, vendor: entityInfo.vendor || null },
      source: 'approval'
    }));

    if (reqDoc.status === 'paused_for_coi' && reqDoc.paused_at) {
      events.push(normalizeEvent({
        id: `approval-coi-paused-${requestId}`, timestamp: reqDoc.paused_at,
        actor: { id: reqDoc.submitted_by?._id?.toString(), name: toName(reqDoc.submitted_by), role: toRole(reqDoc.submitted_by) },
        action: 'Paused for COI', module, request_type: reqDoc.request_type, request_id: requestId,
        details: { coi_request_id: reqDoc.current_coi_request_id || null }, source: 'approval'
      }));
    }

    (reqDoc.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `approval-step-approved-${requestId}-${idx}`, timestamp: step.approved_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Approved request', module, request_type: reqDoc.request_type, request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { comments: step.comments || null, acknowledgement_note: step.acknowledgement_note || null, acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null },
          source: 'approval'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `approval-step-rejected-${requestId}-${idx}`, timestamp: step.rejected_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Rejected request', module, request_type: reqDoc.request_type, request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { reason: step.rejection_reason || step.comments || null, acknowledgement_note: step.acknowledgement_note || null, acknowledgement_files: step.acknowledgement_files?.length ? step.acknowledgement_files : null },
          source: 'approval'
        }));
      }
    });

    (reqDoc.rejection_reviews || []).forEach((review, idx) => {
      events.push(normalizeEvent({
        id: `rejection-forwarded-${requestId}-${idx}`, timestamp: review.created_at,
        actor: { id: review.rejected_by?._id?.toString(), name: toName(review.rejected_by), role: toRole(review.rejected_by) },
        action: 'Forwarded rejection', module, request_type: reqDoc.request_type, request_id: requestId,
        details: { forwarded_to: toName(review.forwarded_to), comments: review.rejection_comments || null, step_index: review.step_index },
        source: 'rejection_review'
      }));
      if (review.review_action && review.reviewed_at) {
        events.push(normalizeEvent({
          id: `rejection-reviewed-${requestId}-${idx}`, timestamp: review.reviewed_at,
          actor: { id: review.forwarded_to?._id?.toString(), name: toName(review.forwarded_to), role: toRole(review.forwarded_to) },
          action: review.review_action === 'accept_rejection' ? 'Rejection accepted' : 'Rejection declined',
          module, request_type: reqDoc.request_type, request_id: requestId,
          details: { review_comments: review.review_comments || null }, source: 'rejection_review'
        }));
      }
    });
  } else if (source === 'coi') {
    module = 'coi';
    events.push(normalizeEvent({
      id: `coi-submitted-${requestId}`, timestamp: reqDoc.created_at,
      actor: { id: reqDoc.submitted_by?._id?.toString(), name: toName(reqDoc.submitted_by), role: toRole(reqDoc.submitted_by) },
      action: 'Submitted COI', module, request_type: 'coi', request_id: requestId,
      details: { reason: reqDoc.coi_reason || null, parent_approval_request_id: reqDoc.parent_approval_request_id?.toString() || null },
      source: 'coi'
    }));
    (reqDoc.approval_steps || []).forEach((step, idx) => {
      if (step.approved_at) {
        events.push(normalizeEvent({
          id: `coi-step-approved-${requestId}-${idx}`, timestamp: step.approved_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Approved COI step', module, request_type: 'coi', request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { comments: step.comments || null }, source: 'coi'
        }));
      }
      if (step.rejected_at) {
        events.push(normalizeEvent({
          id: `coi-step-rejected-${requestId}-${idx}`, timestamp: step.rejected_at,
          actor: { id: step.approver_user_id?._id?.toString(), name: toName(step.approver_user_id), role: step.approver_position_id?.title || toRole(step.approver_user_id) },
          action: 'Rejected COI step', module, request_type: 'coi', request_id: requestId,
          step: { index: idx, level: step.level, position: step.approver_position_id?.title || null },
          details: { reason: step.rejection_reason || step.comments || null }, source: 'coi'
        }));
      }
    });
  } else if (source === 'complaint') {
    module = 'complaint';
    const actorUser = reqDoc.assigned_to;
    const actor = { id: actorUser?._id?.toString(), name: toName(actorUser), role: toRole(actorUser) };
    const rd = reqDoc.resolution_details || {};
    entityInfo = { title: reqDoc.complaint_title };

    if (rd.root_cause) {
      events.push(normalizeEvent({
        id: `complaint-resolution-${requestId}`, timestamp: rd.completed_at || reqDoc.updated_at,
        actor, action: 'Resolution details saved', module, request_type: 'complaint', request_id: requestId,
        details: { complaint_title: reqDoc.complaint_title }, source: 'complaint'
      }));
    }
    if (reqDoc.linked_risk_id) {
      const riskDoc = await Risk.findById(reqDoc.linked_risk_id).select('title').lean();
      events.push(normalizeEvent({
        id: `complaint-risk-${requestId}`, timestamp: rd.risk_linked_at || reqDoc.updated_at,
        actor, action: 'Risk linked to complaint', module, request_type: 'complaint', request_id: requestId,
        details: { complaint_title: reqDoc.complaint_title, risk_title: riskDoc?.title || null }, source: 'complaint'
      }));
    }
    if (reqDoc.status === 'resolved') {
      events.push(normalizeEvent({
        id: `complaint-resolved-${requestId}`, timestamp: rd.resolved_at || reqDoc.updated_at,
        actor, action: 'Complaint resolved', module, request_type: 'complaint', request_id: requestId,
        details: { complaint_title: reqDoc.complaint_title }, source: 'complaint'
      }));
    }
  }

  const sorted = events.filter(e => e.timestamp).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Build unique actors set
  const actorMap = new Map();
  sorted.forEach(e => {
    if (e.actor?.id && !actorMap.has(e.actor.id)) {
      actorMap.set(e.actor.id, { name: e.actor.name, role: e.actor.role });
    }
  });
  const uniqueActors = Array.from(actorMap.values());

  // Generate PDF
  const { generateAuditTrailPDF } = await import('../services/auditTrailPdfService.js');
  const pdfBuffer = await generateAuditTrailPDF(sorted, uniqueActors, entityInfo, module, requestId, logoUrl);

  const fileName = `audit_trail_${requestId}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

export default { getAuditTrail, downloadAuditTrailPDF };
