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
      .optional()
      .isMongoId()
      .withMessage('Category must be a valid department ID if provided'),
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
      .optional()
      .isMongoId()
      .withMessage('Category must be a valid department ID if provided'),
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
// ─── Complaint workflow routing ──────────────────────────────────────────────
router.post(
  '/:complaintId/workflow/triage-complete',
  [param('complaintId').notEmpty().withMessage('Complaint ID is required')],
  validate,
  complaintController.workflowTriageComplete
);

router.post(
  '/:complaintId/workflow/dept-head-complete',
  [param('complaintId').notEmpty().withMessage('Complaint ID is required')],
  validate,
  complaintController.workflowDeptHeadComplete
);

router.post(
  '/:complaintId/workflow/set-major',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('is_major').isBoolean().withMessage('is_major must be a boolean'),
  ],
  validate,
  complaintController.workflowSetMajor
);

router.post(
  '/:complaintId/workflow/select-board-signoff',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('board_member_id').notEmpty().isMongoId().withMessage('Valid board_member_id is required'),
  ],
  validate,
  complaintController.workflowSelectBoardSignoff
);

router.post(
  '/:complaintId/workflow/escalate',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('to_user_id').notEmpty().isMongoId().withMessage('Valid to_user_id is required'),
    body('reason').optional().trim(),
  ],
  validate,
  complaintController.workflowEscalate
);

router.post(
  '/:complaintId/workflow/deescalate',
  [param('complaintId').notEmpty().withMessage('Complaint ID is required')],
  validate,
  complaintController.workflowDeescalate
);

router.post(
  '/:complaintId/workflow/board-signoff',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('signature_data').notEmpty().isString().withMessage('signature_data is required'),
    body('notes').optional().trim(),
  ],
  validate,
  complaintController.workflowBoardSignoff
);

// Admin Triage: Select Department (required before approval)
router.post(
  '/:complaintId/workflow/admin-triage-select-department',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('department_id').notEmpty().isMongoId().withMessage('Valid department_id is required'),
    body('is_major').optional().isBoolean().withMessage('is_major must be a boolean'),
  ],
  validate,
  complaintController.adminTriageSelectDepartment
);

// Admin Approval
router.post(
  '/:complaintId/workflow/admin-approve',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('notes').optional().trim(),
  ],
  validate,
  complaintController.adminApproveComplaint
);

// Admin Rejection
router.post(
  '/:complaintId/workflow/admin-reject',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('reason').optional().trim(),
  ],
  validate,
  complaintController.adminRejectComplaint
);

// Dept Head Approval
router.post(
  '/:complaintId/workflow/dept-head-approve',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('notes').optional().trim(),
  ],
  validate,
  complaintController.deptHeadApproveComplaint
);

// Dept Head Rejection
router.post(
  '/:complaintId/workflow/dept-head-reject',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    body('reason').optional().trim(),
  ],
  validate,
  complaintController.deptHeadRejectComplaint
);

// Complete Resolution Steps (1, 2, 3)
router.post(
  '/:complaintId/workflow/resolution-step/:step',
  [
    param('complaintId').notEmpty().withMessage('Complaint ID is required'),
    param('step').isIn(['1', '2', '3']).withMessage('Step must be 1, 2, or 3'),
    body('data').optional().isObject().withMessage('data must be an object'),
  ],
  validate,
  complaintController.completeResolutionStep
);

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
