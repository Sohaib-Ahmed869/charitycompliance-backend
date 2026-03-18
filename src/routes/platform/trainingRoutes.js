/**
 * Training Routes
 *
 * API routes for training programs, modules, resources, and register.
 */

import express from 'express';
import * as trainingController from '../../controllers/trainingController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadTrainingSingle, handleTrainingUploadError } from '../../middleware/upload.js';

const router = express.Router();

// Public external training (no login; token-based)
router.get(
  '/public/enrollments/:token',
  [param('token').notEmpty().withMessage('Token is required')],
  validate,
  trainingController.getExternalEnrollmentByToken
);

router.post(
  '/public/enrollments/:token/progress',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('resource_id').notEmpty().isMongoId().withMessage('Valid resource_id is required'),
    body('status').optional().isIn(['not_started', 'in_progress', 'completed']),
    body('video_seconds_watched').optional().isFloat({ min: 0 }),
    body('pdf_percent_read').optional().isFloat({ min: 0, max: 100 })
  ],
  validate,
  trainingController.updateExternalEnrollmentProgress
);

router.post(
  '/public/enrollments/:token/complete',
  [param('token').notEmpty().withMessage('Token is required')],
  validate,
  trainingController.completeExternalEnrollment
);

router.get(
  '/public/enrollments/:token/resources/:resourceId/view-url',
  [
    param('token').notEmpty().withMessage('Token is required'),
    param('resourceId').isMongoId().withMessage('Invalid resource ID')
  ],
  validate,
  trainingController.getExternalEnrollmentResourceViewUrl
);

router.get(
  '/public/enrollments/:token/resources/:resourceId/stream',
  [
    param('token').notEmpty().withMessage('Token is required'),
    param('resourceId').isMongoId().withMessage('Invalid resource ID')
  ],
  validate,
  trainingController.streamExternalEnrollmentResource
);

// Authenticated routes
router.use(authAndResolveTenant);

// --- Upload resource file (from PC) ---
router.post(
  '/upload',
  uploadTrainingSingle,
  handleTrainingUploadError,
  trainingController.uploadResourceFile
);

// --- Resource view URL (for in-app video/PDF) ---
router.get(
  '/resources/:resourceId/view-url',
  [param('resourceId').isMongoId().withMessage('Invalid resource ID')],
  validate,
  trainingController.getResourceViewUrl
);

// --- Stream PDF for in-app viewing (member-facing, same-origin) ---
router.get(
  '/resources/:resourceId/stream',
  [param('resourceId').isMongoId().withMessage('Invalid resource ID')],
  validate,
  trainingController.streamResourcePdf
);

// --- Update resource duration from actual video (member-facing, only when not set) ---
router.patch(
  '/resources/:resourceId/duration',
  [
    param('resourceId').isMongoId().withMessage('Invalid resource ID'),
    body('duration_seconds').isFloat({ min: 0 }).withMessage('duration_seconds must be a non-negative number')
  ],
  validate,
  trainingController.updateResourceDuration
);

// --- Register metrics & list ---
router.get(
  '/register/metrics',
  validate,
  trainingController.getRegisterMetrics
);

// --- Training completion activity heatmap ---
router.get(
  '/activity/heatmap',
  [
    query('start_date').optional().isISO8601().withMessage('start_date must be an ISO date'),
    query('end_date').optional().isISO8601().withMessage('end_date must be an ISO date')
  ],
  validate,
  trainingController.getTrainingActivityHeatmap
);

router.get(
  '/register/list',
  [
    query('category').optional().isIn(['staff', 'volunteer', 'board_member']).withMessage('Invalid category'),
    query('search').optional().trim()
  ],
  validate,
  trainingController.getRegisterList
);

// --- Person training record ---
router.get(
  '/register/person/:boardMemberId',
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  trainingController.getPersonTrainingRecord
);

// --- My training (member's assigned courses) ---
router.get('/me', validate, trainingController.getMyTraining);

// Report data for exports
router.get(
  '/programs/:programId/report-data',
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  trainingController.getProgramReportData
);

router.get(
  '/enrollments/:enrollmentId/report-data',
  [param('enrollmentId').isMongoId().withMessage('Invalid enrollment ID')],
  validate,
  trainingController.getEnrollmentReportData
);

router.get(
  '/programs/:programId/pdf',
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  trainingController.exportProgramPdf
);

router.get(
  '/enrollments/:enrollmentId/pdf',
  [param('enrollmentId').isMongoId().withMessage('Invalid enrollment ID')],
  validate,
  trainingController.exportEnrollmentPdf
);

// --- Update resource progress (video/PDF tracking) ---
router.patch(
  '/enrollments/:enrollmentId/completions/:resourceId',
  [
    param('enrollmentId').isMongoId().withMessage('Invalid enrollment ID'),
    param('resourceId').isMongoId().withMessage('Invalid resource ID'),
    body('video_seconds_watched').optional().isFloat({ min: 0 }),
    body('pdf_percent_read').optional().isFloat({ min: 0, max: 100 }),
    body('status').optional().isIn(['not_started', 'in_progress', 'completed']),
    body('signature_data').optional().isString()
  ],
  validate,
  trainingController.updateResourceProgress
);

// --- Post-training survey ---
router.patch(
  '/enrollments/:enrollmentId/survey',
  [
    param('enrollmentId').isMongoId().withMessage('Invalid enrollment ID'),
    body('rating').optional().isInt({ min: 1, max: 5 }).withMessage('rating must be between 1 and 5'),
    body('clarity')
      .optional()
      .isIn(['very_clear', 'somewhat_clear', 'confusing'])
      .withMessage('clarity must be very_clear, somewhat_clear, or confusing'),
    body('relevance')
      .optional()
      .isIn(['very_relevant', 'somewhat_relevant', 'not_relevant'])
      .withMessage('relevance must be very_relevant, somewhat_relevant, or not_relevant'),
    body('comments').optional().isString().isLength({ max: 2000 })
  ],
  validate,
  trainingController.saveEnrollmentSurvey
);

// --- Programs ---
router.get(
  '/programs',
  [
    query('status').optional().isIn(['draft', 'published']).withMessage('Invalid status'),
    query('includeDraft').optional().isIn(['true', 'false']).withMessage('includeDraft must be true or false')
  ],
  validate,
  trainingController.getPrograms
);

router.get(
  '/programs/:programId',
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  trainingController.getProgramById
);

router.post(
  '/programs',
  [
    body('title').optional().trim(),
    body('category').optional().trim(),
    body('description').optional().trim(),
    body('expires').optional().isBoolean(),
    body('renewal_months').optional().isInt({ min: 1, max: 120 }),
    body('department_ids').optional().isArray(),
    body('position_ids').optional().isArray(),
    body('track_completion_status').optional().isBoolean(),
    body('record_completion_dates').optional().isBoolean(),
    body('store_evidence').optional().isBoolean()
  ],
  validate,
  trainingController.createProgram
);

router.put(
  '/programs/:programId',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    body('title').optional().trim(),
    body('category').optional().trim(),
    body('description').optional().trim(),
    body('expires').optional().isBoolean(),
    body('renewal_months').optional().isInt({ min: 1, max: 120 }),
    body('department_ids').optional().isArray(),
    body('position_ids').optional().isArray(),
    body('track_completion_status').optional().isBoolean(),
    body('record_completion_dates').optional().isBoolean(),
    body('store_evidence').optional().isBoolean()
  ],
  validate,
  trainingController.updateProgram
);

router.post(
  '/programs/:programId/publish',
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  trainingController.publishProgram
);

router.delete(
  '/programs/:programId',
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  trainingController.deleteProgram
);

// --- Assign program to people ---
router.post(
  '/programs/:programId/assign',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    body('board_member_ids').isArray().withMessage('board_member_ids must be an array'),
    body('board_member_ids.*').isMongoId().withMessage('Invalid board member ID')
  ],
  validate,
  trainingController.assignProgramToPeople
);

// --- Modules ---
router.post(
  '/programs/:programId/modules',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    body('title').optional().trim(),
    body('description').optional().trim(),
    body('order').optional().isInt({ min: 0 })
  ],
  validate,
  trainingController.createModule
);

router.put(
  '/programs/:programId/modules/:moduleId',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    param('moduleId').isMongoId().withMessage('Invalid module ID'),
    body('title').optional().trim(),
    body('description').optional().trim(),
    body('order').optional().isInt({ min: 0 })
  ],
  validate,
  trainingController.updateModule
);

router.delete(
  '/programs/:programId/modules/:moduleId',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    param('moduleId').isMongoId().withMessage('Invalid module ID')
  ],
  validate,
  trainingController.deleteModule
);

// --- Resources ---
router.post(
  '/programs/:programId/modules/:moduleId/resources',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    param('moduleId').isMongoId().withMessage('Invalid module ID'),
    body('name').optional().trim(),
    body('type').optional().isIn(['pdf', 'video', 'link']).withMessage('type must be pdf, video, or link'),
    body('file_url').optional().trim(),
    body('link_url').optional().trim(),
    body('cover_image_url').optional().trim(),
    body('order').optional().isInt({ min: 0 }),
    body('estimated_minutes').optional().isInt({ min: 0 })
  ],
  validate,
  trainingController.createResource
);

router.put(
  '/programs/:programId/modules/:moduleId/resources/:resourceId',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    param('moduleId').isMongoId().withMessage('Invalid module ID'),
    param('resourceId').isMongoId().withMessage('Invalid resource ID'),
    body('name').optional().trim(),
    body('type').optional().isIn(['pdf', 'video', 'link']).withMessage('type must be pdf, video, or link'),
    body('file_url').optional().trim(),
    body('link_url').optional().trim(),
    body('cover_image_url').optional().trim(),
    body('order').optional().isInt({ min: 0 }),
    body('estimated_minutes').optional().isInt({ min: 0 })
  ],
  validate,
  trainingController.updateResource
);

router.delete(
  '/programs/:programId/modules/:moduleId/resources/:resourceId',
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    param('moduleId').isMongoId().withMessage('Invalid module ID'),
    param('resourceId').isMongoId().withMessage('Invalid resource ID')
  ],
  validate,
  trainingController.deleteResource
);

export default router;
