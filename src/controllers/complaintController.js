/**
 * Complaint Controller
 *
 * Handles HTTP requests for complaint management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { getRouterConnection } from '../config/database.js';
import { ComplaintRepository, PublicComplaintLinkRepository } from '../repositories/complaintRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { lookupTenant } from '../db/router.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';
import { NotificationRepository } from '../repositories/notificationRepository.js';

const normalize = (s) => String(s || '').trim().toLowerCase();

async function getOrgOwnerUserId(tenantDb) {
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);
  const owner = await userRepo.findOrgOwner();
  return owner?._id ? String(owner._id) : null;
}

async function userCanCharityAdminEdit(tenantDb, orgObjectId, userId) {
  if (!userId) return false;
  const ownerId = await getOrgOwnerUserId(tenantDb);
  if (ownerId && String(ownerId) === String(userId)) return true;

  const positionSchema = (await import('../db/schemas/platform/positionSchema.js')).default;
  const boardMemberSchema = (await import('../db/schemas/platform/boardMemberSchema.js')).default;
  tenantDb.models.Position || tenantDb.model('Position', positionSchema);
  tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const Position = tenantDb.model('Position');
  const BoardMember = tenantDb.model('BoardMember');

  const bm = await BoardMember.findOne({ org_id: orgObjectId, user_id: userId }).select('position_id').lean();
  if (!bm?.position_id) return false;
  const pos = await Position.findById(bm.position_id).select('module_permissions').lean();
  const mps = Array.isArray(pos?.module_permissions) ? pos.module_permissions : [];
  const mp = mps.find(x => String(x?.module_id) === 'charity_admin');
  return !!mp?.edit;
}

async function getDeptHeadUserIds(tenantDb, orgObjectId, departmentName) {
  const boardMemberSchema = (await import('../db/schemas/platform/boardMemberSchema.js')).default;
  tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const BoardMember = tenantDb.model('BoardMember');

  const heads = await BoardMember.find({
    org_id: orgObjectId,
    is_head_of_department: true,
    status: 'active',
    user_id: { $ne: null },
  }).select('user_id department').lean();

  const target = normalize(departmentName);
  return heads
    .filter(h => normalize(h.department) === target)
    .map(h => String(h.user_id));
}

function getActiveEscalationToUserId(complaint) {
  const stack = Array.isArray(complaint?.escalation_stack) ? complaint.escalation_stack : [];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const e = stack[i];
    if (!e) continue;
    if (!e.resolved_at) return e.to_user_id ? String(e.to_user_id) : null;
  }
  return null;
}

async function ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner }) {
  // NOTE: We do NOT grant blanket admin access to all stages.
  // Different stages require different roles/positions.
  // This enforces the workflow properly.

  const stage = complaint?.workflow_stage || 'admin_triage';
  
  // Escalations can bypass workflow checks for admin_triage and dept_head_review
  // But NOT for workflow_resolution or board_signoff (those are role-specific)
  if (stage !== 'workflow_resolution' && stage !== 'board_signoff') {
    const activeEscalationTo = getActiveEscalationToUserId(complaint);
    if (activeEscalationTo && String(activeEscalationTo) === String(userId)) return;
  }
  
  if (stage === 'admin_triage') {
    // Only admins and charity admin editors can triage (NOT org owner with generic admin role)
    const ok = userRole === 'admin' || await userCanCharityAdminEdit(tenantDb, org._id, userId);
    if (!ok) throw new AppError('Only admins can perform triage', 403, 'FORBIDDEN');
    return;
  }
  
  if (stage === 'dept_head_review') {
    // ONLY department head of this complaint's category can review
    const deptName = complaint?.category?.name || complaint?.category?.toString?.() || '';
    const headIds = await getDeptHeadUserIds(tenantDb, org._id, deptName);
    if (!headIds.includes(String(userId))) {
      throw new AppError('Only the department head can review this complaint', 403, 'FORBIDDEN');
    }
    return;
  }
  
  if (stage === 'workflow_resolution') {
    // Department heads MUST act - escalations do NOT bypass this
    const deptName = complaint?.category?.name || complaint?.category?.toString?.() || '';
    const headIds = await getDeptHeadUserIds(tenantDb, org._id, deptName);
    if (!headIds.includes(String(userId))) {
      throw new AppError('Only department head can complete resolution steps', 403, 'FORBIDDEN');
    }
    return;
  }
  
  if (stage === 'board_signoff') {
    // ONLY the selected board member can sign off - even escalations do NOT bypass this
    const signoffUserId = complaint?.board_signoff_user_id ? String(complaint.board_signoff_user_id) : null;
    if (!signoffUserId || String(signoffUserId) !== String(userId)) {
      throw new AppError('Only the selected board member can sign off', 403, 'FORBIDDEN');
    }
    return;
  }
  
  if (stage === 'resolved') {
    throw new AppError('This complaint is already resolved', 400, 'ALREADY_RESOLVED');
  }
}

// Get all complaints for organization
export const getComplaints = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Check if user is org owner
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  const isOrgOwner = user?.is_org_owner || false;
  const isAdmin = userRole === 'admin' || isOrgOwner;

  const filters = {
    status: req.query.status,
    category: req.query.category,
    priority: req.query.priority,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  };

  // Anyone with access to the complaints module can view the full register.
  // Actions (resolve/link risk/etc.) are still restricted server-side to the assigned user or admin.

  const complaints = await complaintRepo.findByOrgId(org._id, filters);

  res.json({
    success: true,
    data: complaints,
  });
});

// Get complaint by ID
export const getComplaintById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  res.json({
    success: true,
    data: complaint,
  });
});

// Create complaint (authenticated)
export const createComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const complaintData = {
    org_id: org._id,
    complainant_name: req.body.complainant_name,
    complainant_email: req.body.complainant_email,
    complainant_occupation: req.body.complainant_occupation,
    complaint_title: req.body.complaint_title,
    description: req.body.description,
    category: req.body.category || null, // Department selected by admin during triage, not during registration
    submit_anonymously: req.body.submit_anonymously || false,
    submission_method: req.body.submission_method || 'website', // 'website' = internal staff submission
    status: 'new',
    workflow_stage: 'admin_triage',
    priority: req.body.priority || 'medium',
    dept_head_approval_decision: 'pending',
    admin_approval_decision: 'pending',
    attachments: Array.isArray(req.body.attachments)
      ? req.body.attachments.map((attachment) => ({
          filename: attachment?.filename || '',
          size: attachment?.size || '',
          mime: attachment?.mime || '',
          data_url: attachment?.data_url || '',
          uploaded_at: attachment?.uploaded_at ? new Date(attachment.uploaded_at) : new Date(),
          uploaded_by: req.user?.userId || null,
        }))
      : [],
    trail: [
      {
        at: new Date(),
        actor_user_id: req.user?.userId || null,
        action: 'created',
        details: { submission_method: req.body.submission_method || 'website' },
      },
    ],
  };

  const complaint = await complaintRepo.create(complaintData);

  logInfo('Complaint created', {
    complaintId: complaint._id,
    orgId: org._id,
    submissionMethod: complaintData.submission_method,
  });

  res.json({
    success: true,
    data: complaint,
  });
});

// Get departments for public form (no auth required, but tied to public link)
export const getPublicDepartments = asyncHandler(async (req, res) => {
  const { token } = req.params;
  
  // Get router connection string from env to query with raw MongoDB driver
  const routerDbUri = process.env.ROUTER_DB_URI;
  const routerClient = new MongoClient(routerDbUri);
  
  try {
    await routerClient.connect();
    const routerDb = routerClient.db('router'); // Default router DB name
    
    // Query public link with raw MongoDB driver (no Mongoose schema issues)
    const publicLink = await routerDb.collection('publiccomplaintlinks')
      .findOne({ link_token: token });

    if (!publicLink) {
      throw new AppError('Invalid or expired public link', 401, 'INVALID_TOKEN');
    }

    if (!publicLink.is_active) {
      throw new AppError('This public link is no longer active', 401, 'LINK_INACTIVE');
    }

    // Check expiry
    if (publicLink.expiry_date && new Date() > publicLink.expiry_date) {
      throw new AppError('This public link has expired', 401, 'LINK_EXPIRED');
    }

    const orgId = publicLink.org_id;
    
    // Get tenant routing info
    let tenantInfo;
    try {
      tenantInfo = await lookupTenant(orgId);
    } catch (err) {
      throw new AppError('Organization not found or inactive', 404, 'ORG_NOT_FOUND');
    }
    
    // Connect to tenant cluster with MongoDB driver
    const tenantClient = new MongoClient(tenantInfo.clusterEndpoint);
    try {
      await tenantClient.connect();
      const tenantDb = tenantClient.db(tenantInfo.dbName);
      
      // Query departments from tenant DB
      const departments = await tenantDb.collection('departments')
        .find({ is_active: true })
        .project({ name: 1, _id: 1 })
        .toArray();

      res.json({
        success: true,
        data: departments || [],
      });
    } finally {
      await tenantClient.close();
    }
  } finally {
    await routerClient.close();
  }
});

// Submit public complaint (no auth required)
export const submitPublicComplaint = asyncHandler(async (req, res) => {
  const { token } = req.params;
  
  // Get router connection string from env to query with raw MongoDB driver
  const routerDbUri = process.env.ROUTER_DB_URI;
  const routerClient = new MongoClient(routerDbUri);
  
  try {
    await routerClient.connect();
    const routerDb = routerClient.db('router'); // Default router DB name
    
    // Query public link with raw MongoDB driver (no Mongoose schema issues)
    const publicLink = await routerDb.collection('publiccomplaintlinks')
      .findOne({ link_token: token });

    if (!publicLink) {
      throw new AppError('Invalid or expired public link', 401, 'INVALID_TOKEN');
    }

    if (!publicLink.is_active) {
      throw new AppError('This public link is no longer active', 401, 'LINK_INACTIVE');
    }

    // Check expiry
    if (publicLink.expiry_date && new Date() > publicLink.expiry_date) {
      throw new AppError('This public link has expired', 401, 'LINK_EXPIRED');
    }

    const orgId = publicLink.org_id;
    const tenantDb = await getTenantConnection(orgId);
    const complaintRepo = new ComplaintRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);

    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }

    const complaintData = {
      org_id: org._id,
      complainant_name: req.body.complainant_name,
      complainant_email: req.body.complainant_email,
      complainant_occupation: req.body.complainant_occupation,
      complaint_title: req.body.complaint_title,
      description: req.body.description,
      category: req.body.category || null, // Department selected by admin during triage, not during public submission
      submit_anonymously: req.body.submit_anonymously || false,
      submission_method: publicLink.link_type,
      status: 'new',
      workflow_stage: 'admin_triage',
      priority: 'medium',
      dept_head_approval_decision: 'pending',
      admin_approval_decision: 'pending',
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
      trail: [
        {
          at: new Date(),
          actor_user_id: null,
          action: 'created',
          details: { submission_method: publicLink.link_type, token },
        },
      ],
    };

    const complaint = await complaintRepo.create(complaintData);

    // Increment submission count using raw MongoDB driver
    await routerDb.collection('publiccomplaintlinks').findOneAndUpdate(
      { link_token: token },
      { $inc: { submission_count: 1 } }
    );

    logInfo('Public complaint submitted', {
      complaintId: complaint._id,
      orgId: org._id,
      linkType: publicLink.link_type,
    });

    res.json({
      success: true,
      message: 'Thank you for your complaint. It has been registered.',
      data: complaint,
    });
  } finally {
    await routerClient.close();
  }
});

// Generate public link
export const generatePublicLink = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { link_type } = req.body;

  if (!['website_embed', 'public_link', 'qr_code'].includes(link_type)) {
    throw new AppError('Invalid link type', 400, 'INVALID_TYPE');
  }

  const routerDb = getRouterConnection();
  const publicLinkRepo = new PublicComplaintLinkRepository(routerDb);
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Generate unique token
  const token = crypto.randomBytes(32).toString('hex');
  const publicUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/public/complaints/${token}`;

  const linkData = {
    org_id: orgId,
    link_token: token,
    link_type,
    public_url: publicUrl,
    is_active: true,
    created_by: req.user.userId,
    expiry_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
  };

  const publicLink = await publicLinkRepo.create(linkData);

  logInfo('Public complaint link generated', {
    linkId: publicLink._id,
    orgId: org._id,
    linkType: link_type,
  });

  res.json({
    success: true,
    data: {
      link_token: publicLink.link_token,
      public_url: publicLink.public_url,
      link_type: publicLink.link_type,
      created_at: publicLink.created_at,
    },
  });
});

// Get public links for organization
export const getPublicLinks = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const routerDb = getRouterConnection();
  const publicLinkRepo = new PublicComplaintLinkRepository(routerDb);
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const links = await publicLinkRepo.findByOrgId(org._id);

  res.json({
    success: true,
    data: links,
  });
});

// Update complaint
export const updateComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);

  logInfo('Update complaint request', { complaintId, orgId, body: req.body });

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  const updatedComplaint = await complaintRepo.update(complaintId, req.body);

  logInfo('Complaint updated', { complaintId, orgId, updatedData: req.body });

  // Notify assignee when complaint is assigned/changed
  try {
    const newAssignedTo = req.body?.assigned_to;
    if (newAssignedTo) {
      const prevAssignedTo = complaint.assigned_to?._id || complaint.assigned_to;
      if (!prevAssignedTo || String(prevAssignedTo) !== String(newAssignedTo)) {
        const notificationRepo = new NotificationRepository(tenantDb);
        await notificationRepo.create({
          user_id: newAssignedTo,
          type: 'complaint_assigned',
          title: 'Complaint assigned to you',
          message: 'A complaint has been assigned to you for review and resolution.',
          link: `/complaints/${complaintId}`,
          related_entity_id: complaintId,
          related_entity_type: 'complaint',
          created_at: new Date()
        });
      }
    }
  } catch (err) {
    logError('Failed to create complaint assignment notification', { error: err?.message, complaintId });
  }

  res.json({
    success: true,
    data: updatedComplaint,
  });
});

// Get complaints statistics
export const getComplaintsStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Check if user is org owner
  const { UserRepository } = await import('../repositories/userRepository.js');
  const userRepo = new UserRepository(tenantDb);
  const user = await userRepo.findById(userId);
  const isOrgOwner = user?.is_org_owner || false;
  const isAdmin = userRole === 'admin' || isOrgOwner;

  // Non-admin/org-owner users only see stats for their assigned complaints
  const filterUserId = !isAdmin ? userId : null;
  const stats = await complaintRepo.getStats(org._id, filterUserId);

  res.json({
    success: true,
    data: stats,
  });
});

// ─── Workflow endpoints (Admin → Dept Head → Board sign-off) ────────────────
// Admin Triage: Select Department and optionally Approve/Reject
export const adminTriageSelectDepartment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { department_id, is_major } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  // Only admins can triage
  const ok = userRole === 'admin' || isOrgOwner || await userCanCharityAdminEdit(tenantDb, org._id, userId);
  if (!ok) throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');

  if ((complaint.workflow_stage || 'admin_triage') !== 'admin_triage') {
    throw new AppError('Complaint is not in admin triage stage', 400, 'INVALID_STAGE');
  }

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      category: department_id,
      is_major: !!is_major,
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'admin_triage_department_selected',
        details: { department_id, is_major: !!is_major },
      },
    },
  });

  res.json({ success: true, data: updated });
});

// Admin Approval/Rejection Decision
export const adminApproveComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { notes } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  if (!complaint.category) {
    throw new AppError('Department must be selected before approval', 400, 'MISSING_DEPARTMENT');
  }

  // Only admins can approve
  const ok = userRole === 'admin' || isOrgOwner || await userCanCharityAdminEdit(tenantDb, org._id, userId);
  if (!ok) throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');

  if ((complaint.workflow_stage || 'admin_triage') !== 'admin_triage') {
    throw new AppError('Complaint must be in admin triage stage', 400, 'INVALID_STAGE');
  }

  // When admin approves, start complaint_resolution workflow
  const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
  const workflowService = new ApprovalWorkflowService(orgId);

  let workflowInstanceId = null;
  try {
    // Create workflow instance for complaint resolution
    const workflowInstance = await workflowService.createComplaintResolutionWorkflow(complaintId, userId, { is_major: complaint.is_major });
    workflowInstanceId = workflowInstance?._id;
  } catch (err) {
    logError('Failed to create complaint resolution workflow', {
      complaintId,
      code: err?.code,
      message: err?.message,
      stack: err?.stack
    });
    // This workflow is required for dept-head approval to proceed.
    throw new AppError(
      err?.message || 'No complaint workflow is configured yet. Please configure a workflow.',
      400,
      err?.code || 'COMPLAINT_WORKFLOW_NOT_CONFIGURED'
    );
  }

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      admin_approval_decision: 'approved',
      admin_approval_notes: notes || '',
      workflow_stage: 'dept_head_review',
      status: 'in_progress',
      workflow_instance_id: workflowInstanceId,
      workflow_instance_type: 'complaint_resolution',
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'admin_approved',
        details: { notes: notes || '', workflow_instance_id: workflowInstanceId || null },
      },
    },
  });

  // Send notification to department head(s)
  try {
    const categoryId = complaint?.category;
    if (categoryId) {
      // Get department info to find department heads
      const departmentSchema = (await import('../db/schemas/platform/departmentSchema.js')).default;
      tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
      const Department = tenantDb.model('Department');
      
      const dept = await Department.findById(categoryId).select('name').lean();
      const deptName = dept?.name || '';
      
      if (deptName) {
        const deptHeadIds = await getDeptHeadUserIds(tenantDb, org._id, deptName);
        
        if (deptHeadIds && deptHeadIds.length > 0) {
          const notifRepo = new NotificationRepository(tenantDb);
          const complaintTitle = complaint.complaint_title || 'Untitled Complaint';
          
          const notifications = deptHeadIds.map(headId => ({
            user_id: headId,
            type: 'complaint_assigned',
            subject: 'Complaint Assigned to Your Department',
            message: `A new complaint "${complaintTitle}" has been assigned to ${deptName} for review.`,
            related_entity_id: complaintId,
            related_entity_type: 'complaint',
            read: false,
            created_at: new Date(),
          }));
          
          await notifRepo.createMany(notifications);
        }
      }
    }
  } catch (err) {
    logError('Failed to send notification to department head', { error: err?.message, complaintId, categoryId: complaint?.category });
    // Continue - notification failure shouldn't block the response
  }

  res.json({ success: true, data: updated });
});

export const adminRejectComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { reason } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  // Only admins can reject
  const ok = userRole === 'admin' || isOrgOwner || await userCanCharityAdminEdit(tenantDb, org._id, userId);
  if (!ok) throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  if ((complaint.workflow_stage || 'admin_triage') !== 'admin_triage') {
    throw new AppError('Complaint must be in admin triage stage', 400, 'INVALID_STAGE');
  }

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      admin_approval_decision: 'rejected',
      admin_approval_notes: reason || '',
      status: 'resolved',
      workflow_stage: 'resolved',
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'admin_rejected',
        details: { reason: reason || '' },
      },
    },
  });

  res.json({ success: true, data: updated });
});

// Dept Head Approval/Rejection
export const deptHeadApproveComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { notes } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  if ((complaint.workflow_stage || 'admin_triage') !== 'dept_head_review') {
    throw new AppError('Complaint is not in department head review stage', 400, 'INVALID_STAGE');
  }

  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  // Ensure complaint resolution workflow instance exists before proceeding.
  // For older complaints created before workflow enforcement, auto-attach the workflow instance if possible.
  if (!complaint.workflow_instance_id || complaint.workflow_instance_type !== 'complaint_resolution') {
    try {
      const { ApprovalWorkflowService } = await import('../services/approvalWorkflowService.js');
      const workflowService = new ApprovalWorkflowService(orgId);
      const workflowInstance = await workflowService.createComplaintResolutionWorkflow(
        complaintId,
        userId,
        { is_major: complaint.is_major }
      );

      if (workflowInstance?._id) {
        await complaintRepo.updateWithOps(complaintId, {
          $set: {
            workflow_instance_id: workflowInstance._id,
            workflow_instance_type: 'complaint_resolution',
          },
          $push: {
            trail: {
              at: new Date(),
              actor_user_id: userId || null,
              action: 'workflow_instance_attached',
              details: { workflow_instance_id: String(workflowInstance._id) },
            },
          },
        });
        complaint.workflow_instance_id = workflowInstance._id;
        complaint.workflow_instance_type = 'complaint_resolution';
      }
    } catch (err) {
      throw new AppError(
        err?.message ||
          'Complaint workflow is not assigned yet. Ask an admin to approve the complaint (this assigns the workflow) or configure the complaint workflow.',
        400,
        err?.code || 'COMPLAINT_WORKFLOW_NOT_ASSIGNED'
      );
    }

    if (!complaint.workflow_instance_id || complaint.workflow_instance_type !== 'complaint_resolution') {
      throw new AppError(
        'Complaint workflow is not assigned yet. Ask an admin to approve the complaint (this assigns the workflow) or configure the complaint workflow.',
        400,
        'COMPLAINT_WORKFLOW_NOT_ASSIGNED'
      );
    }
  }

  const nextStage = complaint.is_major ? 'board_signoff' : 'workflow_resolution';
  if (complaint.is_major && !complaint.board_signoff_user_id) {
    throw new AppError('Select a board member for sign-off before proceeding', 400, 'MISSING_BOARD_SIGNOFF');
  }

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      dept_head_approval_decision: 'approved',
      dept_head_approval_notes: notes || '',
      workflow_stage: nextStage,
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'dept_head_approved',
        details: { notes: notes || '', next_stage: nextStage },
      },
    },
  });

  res.json({ success: true, data: updated });
});

export const deptHeadRejectComplaint = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { reason } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  if ((complaint.workflow_stage || 'admin_triage') !== 'dept_head_review') {
    throw new AppError('Complaint is not in department head review stage', 400, 'INVALID_STAGE');
  }

  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      dept_head_approval_decision: 'rejected',
      dept_head_approval_notes: reason || '',
      status: 'resolved',
      workflow_stage: 'resolved',
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'dept_head_rejected',
        details: { reason: reason || '' },
      },
    },
  });

  res.json({ success: true, data: updated });
});

export const workflowTriageComplete = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  // Only charity admin editors (or org owner / admin role) can triage complete
  const ok = userRole === 'admin' || isOrgOwner || await userCanCharityAdminEdit(tenantDb, org._id, userId);
  if (!ok) throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      workflow_stage: 'dept_head_review',
      status: 'in_progress',
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'admin_triage_completed',
        details: {},
      },
    },
  });

  // Send notification to department head(s)
  try {
    const categoryId = complaint?.category;
    if (categoryId) {
      // Get department info to find department heads
      const departmentSchema = (await import('../db/schemas/platform/departmentSchema.js')).default;
      tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
      const Department = tenantDb.model('Department');
      
      const dept = await Department.findById(categoryId).select('name').lean();
      const deptName = dept?.name || '';
      
      if (deptName) {
        const deptHeadIds = await getDeptHeadUserIds(tenantDb, org._id, deptName);
        
        if (deptHeadIds && deptHeadIds.length > 0) {
          const notifRepo = new NotificationRepository(tenantDb);
          const complaintTitle = complaint.complaint_title || 'Untitled Complaint';
          
          const notifications = deptHeadIds.map(headId => ({
            user_id: headId,
            type: 'complaint_assigned',
            subject: 'Complaint Assigned to Your Department',
            message: `A new complaint "${complaintTitle}" has been assigned to ${deptName} for review.`,
            related_entity_id: complaintId,
            related_entity_type: 'complaint',
            read: false,
            created_at: new Date(),
          }));
          
          await notifRepo.createMany(notifications);
        }
      }
    }
  } catch (err) {
    logError('Failed to send notification to department head', { error: err?.message, complaintId, categoryId: complaint?.category });
    // Continue - notification failure shouldn't block the response
  }

  res.json({ success: true, data: updated });
});

export const workflowDeptHeadComplete = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  if ((complaint.workflow_stage || 'admin_triage') !== 'dept_head_review') {
    throw new AppError('Complaint is not in department head review stage', 400, 'INVALID_STAGE');
  }

  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  const nextStage = complaint.is_major ? 'board_signoff' : 'dept_head_review';
  if (complaint.is_major && !complaint.board_signoff_user_id) {
    throw new AppError('Select a board member for sign-off before proceeding', 400, 'MISSING_BOARD_SIGNOFF');
  }

  const now = new Date();
  const $set = { workflow_stage: nextStage };
  const trailEntries = [
    {
      at: now,
      actor_user_id: userId || null,
      action: 'dept_head_completed',
      details: { next_stage: nextStage },
    },
  ];

  // Automation: when entering board sign-off, ensure risk + training are linked
  if (nextStage === 'board_signoff') {
    if (!complaint.linked_risk_id) {
      const { RiskService } = await import('../services/riskService.js');
      const riskService = new RiskService(orgId);
      const newRisk = await riskService.createRisk(
        {
          title: complaint.complaint_title,
          description: complaint.description,
          category: 'Operational',
          department_id: complaint.category?._id || complaint.category,
          metadata: { source: 'Complaint', complaint_id: String(complaintId) },
        },
        userId
      );
      $set.linked_risk_id = newRisk?._id || null;
      $set['resolution_details.risk_linked_at'] = new Date();
      trailEntries.push({
        at: new Date(),
        actor_user_id: userId || null,
        action: 'risk_linked',
        details: { action: 'create', linked_risk_id: String(newRisk?._id || '') },
      });
    }

    if (!complaint.linked_training_id) {
      const { TrainingRepository } = await import('../repositories/trainingRepository.js');
      const trainingRepo = new TrainingRepository(tenantDb);
      const newTraining = await trainingRepo.createProgram({
        org_id: org._id,
        title: `Training - ${complaint.complaint_title}`,
        category: 'General',
        description: complaint.description,
        status: 'draft',
        created_by: userId,
      });
      $set.linked_training_id = newTraining?._id || null;
      $set['resolution_details.training_linked_at'] = new Date();
      trailEntries.push({
        at: new Date(),
        actor_user_id: userId || null,
        action: 'training_linked',
        details: { action: 'create', linked_training_id: String(newTraining?._id || '') },
      });
    }
  }

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set,
    $push: { trail: { $each: trailEntries } },
  });

  res.json({ success: true, data: updated });
});

export const workflowSetMajor = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { is_major } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const ok = userRole === 'admin' || isOrgOwner || await userCanCharityAdminEdit(tenantDb, org._id, userId);
  if (!ok) throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: { is_major: !!is_major },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'major_flag_set',
        details: { is_major: !!is_major },
      },
    },
  });

  res.json({ success: true, data: updated });
});

export const workflowSelectBoardSignoff = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { board_member_id } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const ok = userRole === 'admin' || isOrgOwner || await userCanCharityAdminEdit(tenantDb, org._id, userId);
  if (!ok) throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');

  const boardMemberSchema = (await import('../db/schemas/platform/boardMemberSchema.js')).default;
  tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const BoardMember = tenantDb.model('BoardMember');
  const bm = await BoardMember.findById(board_member_id).select('user_id is_board_member').lean();
  if (!bm) throw new AppError('Board member not found', 404, 'NOT_FOUND');
  if (!bm.is_board_member) throw new AppError('Selected person is not flagged as a board member', 400, 'INVALID_SELECTION');
  if (!bm.user_id) throw new AppError('Selected board member does not have a linked system user', 400, 'MISSING_USER_LINK');

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      board_signoff_board_member_id: bm._id,
      board_signoff_user_id: bm.user_id,
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'board_signoff_selected',
        details: { board_member_id: String(bm._id), user_id: String(bm.user_id) },
      },
    },
  });

  res.json({ success: true, data: updated });
});

export const workflowEscalate = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { to_user_id, reason } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  const fromStage = complaint.workflow_stage || 'admin_triage';
  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: { assigned_to: to_user_id, status: 'assigned' },
    $push: {
      escalation_stack: {
        from_stage: fromStage,
        to_user_id,
        reason: reason || '',
        created_at: new Date(),
        resolved_at: null,
      },
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'escalated',
        details: { from_stage: fromStage, to_user_id, reason: reason || '' },
      },
    },
  });

  res.json({ success: true, data: updated });
});

export const workflowDeescalate = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  const stack = Array.isArray(complaint.escalation_stack) ? complaint.escalation_stack : [];
  let lastOpen = null;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (!stack[i]?.resolved_at) { lastOpen = stack[i]; break; }
  }
  if (!lastOpen) throw new AppError('No active escalation to de-escalate', 400, 'NO_ACTIVE_ESCALATION');

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      assigned_to: null,
      status: 'in_progress',
      workflow_stage: lastOpen.from_stage || complaint.workflow_stage || 'admin_triage',
      'escalation_stack.$[e].resolved_at': new Date(),
    },
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'deescalated',
        details: { to_stage: lastOpen.from_stage || complaint.workflow_stage || 'admin_triage' },
      },
    },
  }, {
    arrayFilters: [{ 'e._id': lastOpen._id }],
  });

  res.json({ success: true, data: updated });
});

export const workflowBoardSignoff = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { signature_data, notes } = req.body;

  if (!signature_data) throw new AppError('Signature is required', 400, 'VALIDATION_ERROR');

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  if ((complaint.workflow_stage || 'admin_triage') !== 'board_signoff') {
    throw new AppError('Complaint is not in board sign-off stage', 400, 'INVALID_STAGE');
  }

  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  if (!complaint.resolution_details?.root_cause) throw new AppError('Resolution details not completed', 400, 'INCOMPLETE_RESOLUTION');
  if (!complaint.linked_risk_id && !complaint.resolution_details?.risk_linked_at) throw new AppError('Risk step not completed', 400, 'INCOMPLETE_RESOLUTION');
  if (!complaint.linked_training_id) throw new AppError('Training not linked', 400, 'INCOMPLETE_RESOLUTION');

  const now = new Date();
  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      board_signoff: {
        signed_at: now,
        signed_by_user_id: userId,
        signature_data,
        notes: notes || null,
      },
      workflow_stage: 'resolved',
      status: 'resolved',
      'resolution_details.resolved_at': now,
    },
    $push: {
      trail: {
        at: now,
        actor_user_id: userId || null,
        action: 'signed_off',
        details: { notes: notes || '' },
      },
    },
  });

  res.json({ success: true, data: updated });
});

// Workflow Resolution Stage (when complaint not major or as intermediate step)
export const completeResolutionStep = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const { step } = req.params; // 1, 2, or 3 for the three resolution steps
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { data, signature_data } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) throw new AppError('Complaint not found', 404, 'NOT_FOUND');

  if ((complaint.workflow_stage || 'admin_triage') !== 'workflow_resolution') {
    throw new AppError('Complaint is not in workflow resolution stage', 400, 'INVALID_STAGE');
  }

  // Enforce strict role-based permission for workflow resolution
  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  const stepNum = parseInt(step, 10);
  if (![1, 2, 3].includes(stepNum)) {
    throw new AppError('Invalid step number. Must be 1, 2, or 3', 400, 'INVALID_STEP');
  }

  const currentStep = complaint.resolution_step || 0;
  if (stepNum !== currentStep + 1) {
    throw new AppError(`Steps must be completed in order. Current step: ${currentStep}, requested: ${stepNum}`, 400, 'INVALID_STEP_ORDER');
  }

  const $set = { resolution_step: stepNum };
  const actionDetails = {};

  // Step 1: Save resolution details
  if (stepNum === 1) {
    $set['resolution_details.root_cause'] = data?.root_cause || '';
    $set['resolution_details.resolution'] = data?.resolution || '';
    $set['resolution_details.corrective_actions'] = data?.corrective_actions || '';
    actionDetails.step = 'resolution_details';
  }
  // Step 2: Link risk
  else if (stepNum === 2) {
    if (data?.action === 'link' && data?.risk_id) {
      $set.linked_risk_id = data.risk_id;
    } else if (data?.action === 'create' && data?.risk_data) {
      const { RiskService } = await import('../services/riskService.js');
      const riskService = new RiskService(orgId);
      const newRisk = await riskService.createRisk(
        {
          title: data.risk_data.title || complaint.complaint_title,
          description: data.risk_data.description || complaint.description,
          category: data.risk_data.category || 'Operational',
          department_id: complaint.category,
          metadata: { source: 'Complaint', complaint_id: String(complaintId) },
        },
        userId
      );
      $set.linked_risk_id = newRisk._id;
      actionDetails.action = 'create';
    }
    $set['resolution_details.risk_linked_at'] = new Date();
    actionDetails.step = 'risk_linked';
  }
  // Step 3: Link training
  else if (stepNum === 3) {
    if (data?.action === 'link' && data?.training_id) {
      $set.linked_training_id = data.training_id;
    } else if (data?.action === 'create' && data?.training_data) {
      const { TrainingRepository } = await import('../repositories/trainingRepository.js');
      const trainingRepo = new TrainingRepository(tenantDb);
      const newTraining = await trainingRepo.createProgram({
        org_id: org._id,
        title: data.training_data.title || `Training - ${complaint.complaint_title}`,
        category: data.training_data.category || 'General',
        description: data.training_data.description || complaint.description,
        status: 'draft',
        created_by: userId,
      });
      $set.linked_training_id = newTraining._id;
      actionDetails.action = 'create';
    }
    $set['resolution_details.training_linked_at'] = new Date();
    actionDetails.step = 'training_linked';

    // After step 3, determine next stage
    // If major, go to board_signoff
    if (complaint.is_major) {
      if (!complaint.board_signoff_user_id) {
        throw new AppError('Board member must be selected for sign-off', 400, 'MISSING_BOARD_SIGNOFF');
      }
      $set.workflow_stage = 'board_signoff';
      actionDetails.next_stage = 'board_signoff';
    } else {
      // If not major, mark as resolved
      $set.workflow_stage = 'resolved';
      $set.status = 'resolved';
      $set['resolution_details.resolved_at'] = new Date();
      actionDetails.next_stage = 'resolved';
    }
  }

  const updated = await complaintRepo.updateWithOps(complaintId, {
    $set,
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: `resolution_step_${stepNum}_completed`,
        details: actionDetails,
      },
    },
  });

  res.json({ success: true, data: updated });
});

// Step 1: Save resolution details
export const saveResolutionDetails = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  const stage = complaint?.workflow_stage || 'admin_triage';
  if (!['dept_head_review', 'workflow_resolution', 'board_signoff'].includes(stage)) {
    throw new AppError('Resolution details can only be completed during review/resolution/sign-off stages', 400, 'INVALID_STAGE');
  }
  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  const resolutionData = {
    resolution_details: {
      root_cause: req.body.root_cause || '',
      resolution: req.body.resolution || '',
      corrective_actions: req.body.corrective_actions || '',
      preventive_actions: req.body.preventive_actions || '',
      lessons_learned: req.body.lessons_learned || '',
      completed_at: new Date(),
    },
    status: 'in_progress',
  };

  const updatedComplaint = await complaintRepo.updateWithOps(complaintId, {
    $set: resolutionData,
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'resolution_details_saved',
        details: {},
      },
    },
  });

  logInfo('Resolution details saved', { complaintId, orgId, userId });

  res.json({
    success: true,
    data: updatedComplaint,
    message: 'Resolution details saved. Proceed to link risk.',
  });
});

// Step 2: Link or create risk
export const linkOrCreateRisk = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { action, risk_id, risk_data } = req.body;
  
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  const stage = complaint?.workflow_stage || 'admin_triage';
  if (!['dept_head_review', 'workflow_resolution', 'board_signoff'].includes(stage)) {
    throw new AppError('Risk linking can only be completed during review/resolution/sign-off stages', 400, 'INVALID_STAGE');
  }
  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  let linkedRiskId;

  if (action === 'link') {
    linkedRiskId = risk_id;
  } else if (action === 'create') {
    // Create new risk via service to trigger approval workflow
    const { RiskService } = await import('../services/riskService.js');
    const riskService = new RiskService(orgId);
    const newRisk = await riskService.createRisk(
      {
        title: risk_data.title || complaint.complaint_title,
        description: risk_data.description || complaint.description,
        category: risk_data.category || 'Operational',
        department_id: complaint.category,
        likelihood: risk_data?.likelihood,
        consequence: risk_data?.consequence,
        metadata: { source: 'Complaint' }
      },
      userId
    );
    linkedRiskId = newRisk._id;

    logInfo('Risk created from complaint', {
      complaintId,
      riskId: linkedRiskId,
      orgId,
    });
  }

  const riskUpdate = {
    linked_risk_id: linkedRiskId,
  };

  if (action !== 'skip') {
    riskUpdate['resolution_details.risk_linked_at'] = new Date();
  } else {
    riskUpdate['resolution_details.risk_linked_at'] = new Date();
    riskUpdate.linked_risk_id = null;
  }

  const updatedComplaint = await complaintRepo.update(complaintId, riskUpdate);
  await complaintRepo.updateWithOps(complaintId, {
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'risk_linked',
        details: { action, linked_risk_id: linkedRiskId || null },
      },
    },
  });

  res.json({
    success: true,
    data: updatedComplaint,
    message: action === 'skip'
      ? 'Risk step skipped. Proceed to attach training.'
      : 'Risk linked successfully. Proceed to attach training.',
  });
});

// Step 3: Link or create training
export const linkOrCreateTraining = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const { action, training_id, training_data } = req.body;
  
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  const stage = complaint?.workflow_stage || 'admin_triage';
  if (!['dept_head_review', 'workflow_resolution', 'board_signoff'].includes(stage)) {
    throw new AppError('Training linkage can only be completed during review/resolution/sign-off stages', 400, 'INVALID_STAGE');
  }
  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  let trainingId;

  if (action === 'link') {
    trainingId = training_id;
  } else if (action === 'create') {
    // Create new training
    const { TrainingRepository } = await import('../repositories/trainingRepository.js');
    const trainingRepo = new TrainingRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
    const org = await orgRepo.findOne();
    
    const newTrainingData = {
      org_id: org._id,
      title: training_data.title || `Training - ${complaint.complaint_title}`,
      category: training_data.category || 'General',
      description: training_data.description || complaint.description,
      status: 'draft',
      created_by: userId,
    };

    const newTraining = await trainingRepo.createProgram(newTrainingData);
    trainingId = newTraining._id;

    logInfo('Training created from complaint', {
      complaintId,
      trainingId,
      orgId,
    });
  }

  const trainingAttachmentData = {
    training_id: trainingId,
    training_title: training_data?.training_title || req.body.training_title || '',
    notes: training_data?.notes || req.body.notes || '',
  };

  const updatedComplaint = await complaintRepo.update(complaintId, {
    linked_training_id: trainingId,
    training_attachment: trainingAttachmentData,
    'resolution_details.training_linked_at': new Date(),
  });
  await complaintRepo.updateWithOps(complaintId, {
    $push: {
      trail: {
        at: new Date(),
        actor_user_id: userId || null,
        action: 'training_linked',
        details: { action, linked_training_id: trainingId || null },
      },
    },
  });

  res.json({
    success: true,
    data: updatedComplaint,
    message: 'Training linked successfully. Ready to mark as resolved.',
  });
});

// Final: Mark complaint as resolved
export const markComplaintResolved = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const userRole = req.user?.role;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

  const ownerId = await getOrgOwnerUserId(tenantDb);
  const isOrgOwner = ownerId && String(ownerId) === String(userId);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  if (complaint.is_major) {
    throw new AppError('Major complaints must be completed via board sign-off', 400, 'REQUIRES_BOARD_SIGNOFF');
  }

  const stage = complaint.workflow_stage || 'admin_triage';
  if (stage !== 'dept_head_review') {
    throw new AppError('Complaint is not in department head review stage', 400, 'INVALID_STAGE');
  }
  await ensureCanActOnComplaintStage({ tenantDb, org, complaint, userId, userRole, isOrgOwner });

  // Verify all 3 steps completed
  if (!complaint.resolution_details?.root_cause) {
    throw new AppError('Resolution details not completed', 400, 'INCOMPLETE_RESOLUTION');
  }
  if (!complaint.linked_risk_id && !complaint.resolution_details?.risk_linked_at) {
    throw new AppError('Risk step not completed', 400, 'INCOMPLETE_RESOLUTION');
  }
  if (!complaint.linked_training_id) {
    throw new AppError('Training not linked', 400, 'INCOMPLETE_RESOLUTION');
  }

  const now = new Date();
  const updatedComplaint = await complaintRepo.updateWithOps(complaintId, {
    $set: {
      status: 'resolved',
      workflow_stage: 'resolved',
      'resolution_details.resolved_at': now,
    },
    $push: {
      trail: {
        at: now,
        actor_user_id: userId || null,
        action: 'resolved',
        details: {},
      },
    },
  });

  logInfo('Complaint marked as resolved', { complaintId, orgId, userId });

  res.json({
    success: true,
    data: updatedComplaint,
    message: 'Complaint successfully resolved!',
  });
});
