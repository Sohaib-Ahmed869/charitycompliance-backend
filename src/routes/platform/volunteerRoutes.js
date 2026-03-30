import express from 'express';
import { body, param } from 'express-validator';
import {
  generateVolunteerActionLinks,
  regenerateVolunteerActionLinks,
  getVolunteerActionContext,
  getVolunteerSubmissionsStats,
  submitVolunteerComplaint,
  submitVolunteerRisk,
  submitVolunteerCoi,
  getPublicDepartments,
} from '../../controllers/volunteerController.js';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// Public volunteer action links
router.get(
  '/public/:actionType/:token/context',
  [
    param('actionType').isIn(['complaint', 'risk', 'coi']).withMessage('Invalid action type'),
    param('token').notEmpty().withMessage('Token is required'),
  ],
  validate,
  getVolunteerActionContext
);

// Get departments for public risk form (tied to public link token)
router.get(
  '/public/departments/:token',
  [
    param('token')
      .notEmpty()
      .withMessage('Token is required'),
  ],
  validate,
  getPublicDepartments
);

// Complaint submission (full form with attachments)
router.post(
  '/public/complaint/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('complaint_title').trim().notEmpty().withMessage('Complaint title is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
    body('submit_anonymously').optional().isBoolean(),
  ],
  validate,
  submitVolunteerComplaint
);

// Risk submission (full risk assessment form)
router.post(
  '/public/risk/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('title').trim().notEmpty().withMessage('Risk title is required'),
    body('description').optional().trim(),
    body('category').optional().trim(),
    body('department_id').optional(),
    body('existing_controls').optional().trim(),
    body('next_review_date').optional(),
  ],
  validate,
  submitVolunteerRisk
);

// COI submission (external COI form fields)
router.post(
  '/public/coi/:token/submit',
  [
    param('token').notEmpty().withMessage('Token is required'),
    body('coi_reason').trim().notEmpty().withMessage('COI reason is required'),
    body('conflict_person_name').trim().notEmpty().withMessage('Conflict person name is required'),
    body('conflict_person_details').trim().notEmpty().withMessage('Conflict person details are required'),
    body('phone').optional().trim(),
  ],
  validate,
  submitVolunteerCoi
);

// Authenticated actions
router.use(authAndResolveTenant);

router.get('/submissions/stats', getVolunteerSubmissionsStats);

router.post(
  '/:boardMemberId/action-links',
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  generateVolunteerActionLinks
);

router.post(
  '/:boardMemberId/regenerate-tokens',
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  regenerateVolunteerActionLinks
);

export default router;
