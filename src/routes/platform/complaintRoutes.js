/**
 * Complaint Routes
 * 
 * API routes for complaint management
 */

import express from 'express';
import * as complaintController from '../../controllers/complaintController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// Public routes (no auth required)
router.post(
  '/public/submit/:token',
  [
    param('token')
      .notEmpty()
      .withMessage('Token is required'),
    body('complainant_name')
      .trim()
      .notEmpty()
      .withMessage('Complainant name is required'),
    body('complainant_email')
      .isEmail()
      .withMessage('Valid email is required'),
    body('complaint_title')
      .trim()
      .notEmpty()
      .withMessage('Complaint title is required'),
    body('description')
      .trim()
      .notEmpty()
      .withMessage('Description is required'),
    body('category')
      .notEmpty()
      .isMongoId()
      .withMessage('Valid category/department ID is required'),
  ],
  validate,
  complaintController.submitPublicComplaint
);

// Get departments for public form (tied to public link token)
router.get(
  '/public/departments/:token',
  [
    param('token')
      .notEmpty()
      .withMessage('Token is required'),
  ],
  validate,
  complaintController.getPublicDepartments
);

// All authenticated routes require auth and tenant resolution
router.use(authAndResolveTenant);

// Get all complaints
router.get(
  '/',
  complaintController.getComplaints
);

// Get complaints statistics
router.get(
  '/stats/overview',
  complaintController.getComplaintsStats
);

// Get complaint by ID
router.get(
  '/:complaintId',
  [
    param('complaintId')
      .notEmpty()
      .withMessage('Complaint ID is required'),
  ],
  validate,
  complaintController.getComplaintById
);

// Create complaint
router.post(
  '/',
  [
    body('complainant_name')
      .trim()
      .notEmpty()
      .withMessage('Complainant name is required'),
    body('complainant_email')
      .isEmail()
      .withMessage('Valid email is required'),
    body('complaint_title')
      .trim()
      .notEmpty()
      .withMessage('Complaint title is required'),
    body('description')
      .trim()
      .notEmpty()
      .withMessage('Description is required'),
    body('category')
      .notEmpty()
      .isMongoId()
      .withMessage('Valid category/department ID is required'),
  ],
  validate,
  complaintController.createComplaint
);

// Update complaint
router.put(
  '/:complaintId',
  [
    param('complaintId')
      .notEmpty()
      .withMessage('Complaint ID is required'),
    body('assigned_to')
      .optional()
      .notEmpty()
      .withMessage('Assigned to ID cannot be empty')
      .isMongoId()
      .withMessage('Invalid user ID format for assigned_to'),
  ],
  validate,
  complaintController.updateComplaint
);

// Generate public link
router.post(
  '/public-links/generate',
  [
    body('link_type')
      .notEmpty()
      .isIn(['website_embed', 'public_link', 'qr_code'])
      .withMessage('Invalid link type'),
  ],
  validate,
  complaintController.generatePublicLink
);

// Get public links
router.get(
  '/public-links/all',
  complaintController.getPublicLinks
);

// Resolution workflow routes
// Step 1: Save resolution details
router.post(
  '/:complaintId/resolution-details',
  [
    param('complaintId')
      .notEmpty()
      .withMessage('Complaint ID is required'),
    body('root_cause')
      .trim()
      .notEmpty()
      .withMessage('Root cause is required'),
    body('resolution')
      .trim()
      .notEmpty()
      .withMessage('Resolution is required'),
    body('corrective_actions')
      .trim()
      .notEmpty()
      .withMessage('Corrective actions are required'),
    body('preventive_actions')
      .trim()
      .notEmpty()
      .withMessage('Preventive actions are required'),
    body('lessons_learned')
      .trim()
      .notEmpty()
      .withMessage('Lessons learned are required'),
  ],
  validate,
  complaintController.saveResolutionDetails
);

// Step 2: Link or create risk
router.post(
  '/:complaintId/link-risk',
  [
    param('complaintId')
      .notEmpty()
      .withMessage('Complaint ID is required'),
    body('action')
      .notEmpty()
      .isIn(['link', 'create', 'skip'])
      .withMessage('Action must be link, create, or skip'),
  ],
  validate,
  complaintController.linkOrCreateRisk
);

// Step 3: Link or create training
router.post(
  '/:complaintId/link-training',
  [
    param('complaintId')
      .notEmpty()
      .withMessage('Complaint ID is required'),
    body('action')
      .notEmpty()
      .isIn(['link', 'create'])
      .withMessage('Action must be link or create'),
  ],
  validate,
  complaintController.linkOrCreateTraining
);

// Final: Mark as resolved
router.post(
  '/:complaintId/mark-resolved',
  [
    param('complaintId')
      .notEmpty()
      .withMessage('Complaint ID is required'),
  ],
  validate,
  complaintController.markComplaintResolved
);

export default router;
