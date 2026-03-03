/**
 * Support Ticket Service
 * 
 * Business logic for support ticket management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { SupportTicketRepository } from '../repositories/supportTicketRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';

export class SupportTicketService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /**
   * Create a new support ticket
   */
  async createTicket(ticketData, userId = null, geoInfo = null) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);

    const ticketNumber = await ticketRepo.generateTicketNumber(this.orgId);

    const reporter = userId
      ? { user_id: userId, is_external: false }
      : { 
          name: ticketData.reporter_name, 
          email: ticketData.reporter_email, 
          is_external: true,
          country: geoInfo?.country || ticketData.country || null,
          country_code: geoInfo?.country_code || ticketData.country_code || null
        };

    // If internal user, try to get their country from geoInfo
    if (userId && geoInfo) {
      reporter.country = geoInfo.country;
      reporter.country_code = geoInfo.country_code;
    }

    const ticket = await ticketRepo.create({
      org_id: this.orgId,
      ticket_number: ticketNumber,
      summary: ticketData.summary,
      description: ticketData.description,
      priority: ticketData.priority || 'medium',
      category: ticketData.category || 'general',
      reporter,
      status: 'new'
    });

    logInfo('Support ticket created', { ticketId: ticket._id, ticketNumber });

    return ticket;
  }

  /**
   * Get all tickets with filters
   */
  async getTickets(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);
    return await ticketRepo.findByOrgId(this.orgId, filters);
  }

  /**
   * Get ticket by ID
   */
  async getTicketById(ticketId) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    return ticket;
  }

  /**
   * Update ticket
   */
  async updateTicket(ticketId, updateData) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    logInfo('Support ticket updated', { ticketId, updates: Object.keys(updateData) });

    return await ticketRepo.update(ticketId, {
      ...updateData,
      updated_at: new Date()
    });
  }

  /**
   * Assign ticket to user
   */
  async assignTicket(ticketId, assigneeUserId) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    const updatedTicket = await ticketRepo.update(ticketId, {
      'assignee.user_id': assigneeUserId,
      'assignee.assigned_at': new Date(),
      status: ticket.status === 'new' ? 'in_progress' : ticket.status,
      updated_at: new Date()
    });

    // Create notification for assignee
    await notificationRepo.create({
      user_id: assigneeUserId,
      type: 'ticket_assigned',
      title: 'Ticket Assigned',
      message: `You have been assigned ticket ${ticket.ticket_number}: ${ticket.summary}`,
      link: `/support-tickets/${ticketId}`,
      related_entity_id: ticketId,
      related_entity_type: 'support_ticket'
    });

    logInfo('Support ticket assigned', { ticketId, assigneeUserId });

    return updatedTicket;
  }

  /**
   * Update ticket status
   */
  async updateStatus(ticketId, status, userId = null, resolutionNotes = null) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    const updateData = {
      status,
      updated_at: new Date()
    };

    if (status === 'solved' && userId) {
      updateData.resolution = {
        notes: resolutionNotes,
        resolved_by: userId,
        resolved_at: new Date()
      };
    }

    logInfo('Support ticket status updated', { ticketId, status });

    return await ticketRepo.update(ticketId, updateData);
  }

  /**
   * Add comment to ticket
   */
  async addComment(ticketId, message, userId, isInternal = false) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    const user = await userRepo.findById(userId);
    const userName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Unknown';

    const comments = ticket.comments || [];
    comments.push({
      message,
      created_by: userId,
      created_by_name: userName,
      is_internal: isInternal,
      created_at: new Date()
    });

    // Update first_response_at if this is the first response
    const updateData = {
      comments,
      updated_at: new Date()
    };

    if (!ticket.first_response_at) {
      updateData.first_response_at = new Date();
    }

    logInfo('Comment added to ticket', { ticketId, userId, isInternal });

    return await ticketRepo.update(ticketId, updateData);
  }

  /**
   * Get dashboard stats
   */
  async getStats() {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);
    return await ticketRepo.getStats(this.orgId);
  }

  /**
   * Get trend data
   */
  async getTrendData(days = 30) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);
    return await ticketRepo.getTrendData(this.orgId, days);
  }

  /**
   * Get region stats for map visualization
   */
  async getRegionStats() {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);
    return await ticketRepo.getRegionStats(this.orgId);
  }

  /**
   * Submit satisfaction rating
   */
  async submitSatisfaction(ticketId, rating, feedback = null) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    return await ticketRepo.update(ticketId, {
      satisfaction_rating: rating,
      satisfaction_feedback: feedback,
      updated_at: new Date()
    });
  }

  /**
   * Delete ticket
   */
  async deleteTicket(ticketId) {
    const tenantDb = await this.getTenantDb();
    const ticketRepo = new SupportTicketRepository(tenantDb);

    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) {
      throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    }

    await ticketRepo.delete(ticketId);
    logInfo('Support ticket deleted', { ticketId });
  }

  /**
   * Get public submission link
   */
  getPublicSubmitLink() {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return `${baseUrl}/public/support-ticket/${this.orgId}`;
  }
}
