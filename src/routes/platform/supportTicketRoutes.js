/**
 * Support Ticket Routes
 * 
 * API routes for support ticket / help centre management
 */

import express from 'express';
import * as supportTicketController from '../../controllers/supportTicketController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

// ============================================
// PUBLIC ROUTES (no auth required)
// ============================================

// Get organization info for public ticket form
router.get(
  '/public/org/:orgId',
  [
    param('orgId')
      .notEmpty()
      .withMessage('Organization ID is required')
  ],
  validate,
  supportTicketController.getOrgInfoForPublic
);

// Submit ticket from public form
router.post(
  '/public/submit/:orgId',
  [
    param('orgId')
      .notEmpty()
      .withMessage('Organization ID is required'),
    body('reporter_name')
      .trim()
      .notEmpty()
      .withMessage('Your name is required'),
    body('reporter_email')
      .isEmail()
      .withMessage('Valid email is required'),
    body('summary')
      .trim()
      .notEmpty()
      .withMessage('Issue summary is required'),
    body('description')
      .optional()
      .trim(),
    body('category')
      .optional()
      .isIn(['technical_error', 'bug_report', 'feature_request', 'access_issue', 'data_issue', 'general', 'other', 'technical', 'billing', 'account', 'feedback'])
      .withMessage('Invalid category'),
    body('priority')
      .optional()
      .isIn(['low', 'medium', 'high', 'critical'])
      .withMessage('Invalid priority'),
    body('module')
      .optional()
      .trim()
  ],
  validate,
  supportTicketController.createPublicTicket
);

// Submit satisfaction rating (public)
router.post(
  '/public/satisfaction/:orgId/:ticketId',
  [
    param('orgId')
      .notEmpty()
      .withMessage('Organization ID is required'),
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID'),
    body('rating')
      .isInt({ min: 1, max: 5 })
      .withMessage('Rating must be between 1 and 5'),
    body('feedback')
      .optional()
      .trim()
  ],
  validate,
  supportTicketController.submitSatisfaction
);

// ============================================
// AUTHENTICATED ROUTES
// ============================================

// All routes below require authentication
router.use(authAndResolveTenant);

// Get dashboard stats
router.get(
  '/stats',
  supportTicketController.getStats
);

// Get trend data
router.get(
  '/trends',
  supportTicketController.getTrendData
);

// Get region stats for map
router.get(
  '/regions',
  supportTicketController.getRegionStats
);

// Get public submission link
router.get(
  '/public-link',
  supportTicketController.getPublicLink
);

// Get all tickets
router.get(
  '/',
  supportTicketController.getTickets
);

// Get ticket by ID
router.get(
  '/:ticketId',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID')
  ],
  validate,
  supportTicketController.getTicketById
);

// Create ticket (authenticated user)
router.post(
  '/',
  uploadSingle,
  handleUploadError,
  [
    body('summary')
      .trim()
      .notEmpty()
      .withMessage('Summary is required'),
    body('description')
      .optional()
      .trim(),
    body('priority')
      .optional()
      .isIn(['low', 'medium', 'high', 'critical'])
      .withMessage('Invalid priority'),
    body('category')
      .optional()
      .isIn(['technical_error', 'bug_report', 'feature_request', 'access_issue', 'data_issue', 'general', 'other',
             'technical', 'billing', 'account', 'feedback'])
      .withMessage('Invalid category'),
    body('module')
      .optional()
      .trim()
  ],
  validate,
  supportTicketController.createTicket
);

// Update ticket
router.put(
  '/:ticketId',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID'),
    body('summary')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Summary cannot be empty'),
    body('description')
      .optional()
      .trim(),
    body('priority')
      .optional()
      .isIn(['low', 'medium', 'high', 'critical'])
      .withMessage('Invalid priority'),
    body('category')
      .optional()
      .isIn(['technical_error', 'bug_report', 'feature_request', 'access_issue', 'data_issue', 'general', 'other',
             'technical', 'billing', 'account', 'feedback'])
      .withMessage('Invalid category')
  ],
  validate,
  supportTicketController.updateTicket
);

// Assign ticket
router.post(
  '/:ticketId/assign',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID'),
    body('assignee_id')
      .isMongoId()
      .withMessage('Valid assignee ID is required')
  ],
  validate,
  supportTicketController.assignTicket
);

// Update ticket status
router.patch(
  '/:ticketId/status',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID'),
    body('status')
      .isIn(['new', 'in_progress', 'solved', 'declined', 'on_hold'])
      .withMessage('Invalid status'),
    body('resolution_notes')
      .optional()
      .trim()
  ],
  validate,
  supportTicketController.updateTicketStatus
);

// Add comment to ticket
router.post(
  '/:ticketId/comments',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID'),
    body('message')
      .trim()
      .notEmpty()
      .withMessage('Comment message is required'),
    body('is_internal')
      .optional()
      .isBoolean()
      .withMessage('is_internal must be a boolean')
  ],
  validate,
  supportTicketController.addComment
);

// Get attachment download URL
router.get(
  '/:ticketId/attachments/:attachmentIndex/download',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID'),
    param('attachmentIndex')
      .isInt({ min: 0 })
      .withMessage('Invalid attachment index')
  ],
  validate,
  supportTicketController.getAttachmentUrl
);

// Delete ticket
router.delete(
  '/:ticketId',
  [
    param('ticketId')
      .isMongoId()
      .withMessage('Invalid ticket ID')
  ],
  validate,
  supportTicketController.deleteTicket
);

export default router;
