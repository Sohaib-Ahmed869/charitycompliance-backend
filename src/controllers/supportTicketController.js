/**
 * Support Ticket Controller
 * 
 * Handles HTTP requests for support ticket management
 */

import { SupportTicketService } from '../services/supportTicketService.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';
import { lookupTenant } from '../db/router.js';
import { uploadToS3, getFileUrl } from '../services/s3Service.js';

// Get all tickets
export const getTickets = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const ticketService = new SupportTicketService(orgId);

  const filters = {
    status: req.query.status,
    priority: req.query.priority,
    category: req.query.category,
    assignee: req.query.assignee,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    search: req.query.search
  };

  const tickets = await ticketService.getTickets(filters);

  res.json({
    success: true,
    data: tickets
  });
});

// Get ticket by ID
export const getTicketById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId } = req.params;
  const ticketService = new SupportTicketService(orgId);

  const ticket = await ticketService.getTicketById(ticketId);

  res.json({
    success: true,
    data: ticket
  });
});

// Create ticket (authenticated user)
export const createTicket = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId;
  const ticketService = new SupportTicketService(orgId);

  // Get geo info from request headers (set by reverse proxy or client)
  const geoInfo = {
    country: req.headers['cf-ipcountry'] || req.headers['x-country'] || req.body.country || null,
    country_code: req.headers['cf-ipcountry'] || req.headers['x-country-code'] || req.body.country_code || null
  };

  // Handle file upload to S3 if present
  let attachment = null;
  if (req.file) {
    const { buffer, originalname, mimetype, size } = req.file;
    const { key } = await uploadToS3(buffer, originalname, mimetype, orgId, 'support-tickets');
    attachment = {
      file_name: originalname,
      file_path: key,
      file_size: size,
      mime_type: mimetype
    };
  }

  const ticket = await ticketService.createTicket(req.body, userId, geoInfo, attachment);

  res.status(201).json({
    success: true,
    data: ticket,
    message: 'Ticket created successfully'
  });
});

// Create ticket (public submission)
export const createPublicTicket = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  // Verify org exists
  const tenantInfo = await lookupTenant(orgId);
  if (!tenantInfo) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const ticketService = new SupportTicketService(orgId);

  // Validate required fields for external submission
  if (!req.body.reporter_name || !req.body.reporter_email) {
    throw new AppError('Reporter name and email are required', 400, 'VALIDATION_ERROR');
  }

  if (!req.body.summary) {
    throw new AppError('Summary is required', 400, 'VALIDATION_ERROR');
  }

  // Get geo info from request headers or body
  const geoInfo = {
    country: req.headers['cf-ipcountry'] || req.headers['x-country'] || req.body.country || null,
    country_code: req.headers['cf-ipcountry'] || req.headers['x-country-code'] || req.body.country_code || null
  };

  const ticket = await ticketService.createTicket({
    summary: req.body.summary,
    description: req.body.description,
    category: req.body.category || 'general',
    priority: req.body.priority || 'medium',
    module: req.body.module || undefined,
    reporter_name: req.body.reporter_name,
    reporter_email: req.body.reporter_email
  }, null, geoInfo);

  res.status(201).json({
    success: true,
    data: {
      ticket_number: ticket.ticket_number,
      status: ticket.status
    },
    message: 'Your ticket has been submitted successfully'
  });
});

// Update ticket
export const updateTicket = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId } = req.params;
  const ticketService = new SupportTicketService(orgId);

  const ticket = await ticketService.updateTicket(ticketId, req.body);

  res.json({
    success: true,
    data: ticket,
    message: 'Ticket updated successfully'
  });
});

// Assign ticket
export const assignTicket = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId } = req.params;
  const { assignee_id } = req.body;
  const ticketService = new SupportTicketService(orgId);

  if (!assignee_id) {
    throw new AppError('Assignee ID is required', 400, 'VALIDATION_ERROR');
  }

  const ticket = await ticketService.assignTicket(ticketId, assignee_id);

  res.json({
    success: true,
    data: ticket,
    message: 'Ticket assigned successfully'
  });
});

// Update ticket status
export const updateTicketStatus = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId } = req.params;
  const { status, resolution_notes } = req.body;
  const userId = req.user?.userId;
  const ticketService = new SupportTicketService(orgId);

  if (!status) {
    throw new AppError('Status is required', 400, 'VALIDATION_ERROR');
  }

  const ticket = await ticketService.updateStatus(ticketId, status, userId, resolution_notes);

  res.json({
    success: true,
    data: ticket,
    message: 'Ticket status updated successfully'
  });
});

// Add comment
export const addComment = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId } = req.params;
  const { message, is_internal } = req.body;
  const userId = req.user?.userId;
  const ticketService = new SupportTicketService(orgId);

  if (!message) {
    throw new AppError('Comment message is required', 400, 'VALIDATION_ERROR');
  }

  const ticket = await ticketService.addComment(ticketId, message, userId, is_internal);

  res.json({
    success: true,
    data: ticket,
    message: 'Comment added successfully'
  });
});

// Get dashboard stats
export const getStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const ticketService = new SupportTicketService(orgId);

  const stats = await ticketService.getStats();

  res.json({
    success: true,
    data: stats
  });
});

// Get trend data
export const getTrendData = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const days = parseInt(req.query.days) || 30;
  const ticketService = new SupportTicketService(orgId);

  const trendData = await ticketService.getTrendData(days);

  res.json({
    success: true,
    data: trendData
  });
});

// Get region stats for map
export const getRegionStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const ticketService = new SupportTicketService(orgId);

  const regionStats = await ticketService.getRegionStats();

  res.json({
    success: true,
    data: regionStats
  });
});

// Submit satisfaction rating
export const submitSatisfaction = asyncHandler(async (req, res) => {
  const { orgId, ticketId } = req.params;
  const { rating, feedback } = req.body;

  // Verify org exists
  const tenantInfo = await lookupTenant(orgId);
  if (!tenantInfo) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  if (!rating || rating < 1 || rating > 5) {
    throw new AppError('Rating must be between 1 and 5', 400, 'VALIDATION_ERROR');
  }

  const ticketService = new SupportTicketService(orgId);
  const ticket = await ticketService.submitSatisfaction(ticketId, rating, feedback);

  res.json({
    success: true,
    message: 'Thank you for your feedback'
  });
});

// Delete ticket
export const deleteTicket = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId } = req.params;
  const ticketService = new SupportTicketService(orgId);

  await ticketService.deleteTicket(ticketId);

  res.json({
    success: true,
    message: 'Ticket deleted successfully'
  });
});

// Get attachment download URL
export const getAttachmentUrl = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { ticketId, attachmentIndex } = req.params;
  const ticketService = new SupportTicketService(orgId);

  const ticket = await ticketService.getTicketById(ticketId);
  const idx = parseInt(attachmentIndex, 10);

  if (!ticket.attachments || !ticket.attachments[idx]) {
    throw new AppError('Attachment not found', 404, 'ATTACHMENT_NOT_FOUND');
  }

  const attachment = ticket.attachments[idx];
  const url = await getFileUrl(attachment.file_path);

  res.json({
    success: true,
    data: { url, file_name: attachment.file_name, mime_type: attachment.mime_type }
  });
});

// Get public submission link
export const getPublicLink = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const ticketService = new SupportTicketService(orgId);

  const link = ticketService.getPublicSubmitLink();

  res.json({
    success: true,
    data: { link }
  });
});

// Get organization info for public page
export const getOrgInfoForPublic = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  // Verify org exists
  const tenantInfo = await lookupTenant(orgId);
  if (!tenantInfo) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const { getTenantConnection } = await import('../db/connectionManager.js');
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
  
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();

  res.json({
    success: true,
    data: {
      name: org?.name || 'Organization',
      logo: org?.logo || null
    }
  });
});
