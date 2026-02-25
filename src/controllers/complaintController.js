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

  // Non-admin/org-owner users only see complaints assigned to them
  if (!isAdmin) {
    filters.assigned_to = userId;
  }

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
    category: req.body.category,
    submit_anonymously: req.body.submit_anonymously || false,
    submission_method: req.body.submission_method || 'website', // 'website' = internal staff submission
    status: 'new',
    priority: req.body.priority || 'medium',
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
      category: req.body.category,
      submit_anonymously: req.body.submit_anonymously || false,
      submission_method: publicLink.link_type,
      status: 'new',
      priority: 'medium',
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

// Step 1: Save resolution details
export const saveResolutionDetails = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { complaintId } = req.params;
  const userId = req.user?.userId;
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  // Check permission: only assigned person or admin can resolve
  const isAssigned = complaint.assigned_to?._id?.toString() === userId || 
                      complaint.assigned_to?.toString() === userId;
  const isAdmin = req.user?.role === 'admin';
  
  if (!isAssigned && !isAdmin) {
    throw new AppError('You do not have permission to resolve this complaint', 403, 'FORBIDDEN');
  }

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

  const updatedComplaint = await complaintRepo.update(complaintId, resolutionData);

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
  const { action, risk_id, risk_data } = req.body;
  
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  // Check permission
  const isAssigned = complaint.assigned_to?._id?.toString() === userId || 
                      complaint.assigned_to?.toString() === userId;
  const isAdmin = req.user?.role === 'admin';
  
  if (!isAssigned && !isAdmin) {
    throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');
  }

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
  const { action, training_id, training_data } = req.body;
  
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  // Check permission
  const isAssigned = complaint.assigned_to?._id?.toString() === userId || 
                      complaint.assigned_to?.toString() === userId;
  const isAdmin = req.user?.role === 'admin';
  
  if (!isAssigned && !isAdmin) {
    throw new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN');
  }

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
  const tenantDb = await getTenantConnection(orgId);
  const complaintRepo = new ComplaintRepository(tenantDb);

  const complaint = await complaintRepo.findById(complaintId);
  if (!complaint) {
    throw new AppError('Complaint not found', 404, 'NOT_FOUND');
  }

  // Check permission
  const isAssigned = complaint.assigned_to?._id?.toString() === userId || 
                      complaint.assigned_to?.toString() === userId;
  const isAdmin = req.user?.role === 'admin';
  
  if (!isAssigned && !isAdmin) {
    throw new AppError('You do not have permission to resolve this complaint', 403, 'FORBIDDEN');
  }

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

  const updatedComplaint = await complaintRepo.update(complaintId, {
    status: 'resolved',
    'resolution_details.resolved_at': new Date(),
  });

  logInfo('Complaint marked as resolved', { complaintId, orgId, userId });

  res.json({
    success: true,
    data: updatedComplaint,
    message: 'Complaint successfully resolved!',
  });
});
