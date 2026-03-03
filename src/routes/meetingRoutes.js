import express from 'express';
import { MeetingController } from '../controllers/meetingController.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { body, param, validationResult } from 'express-validator';

const router = express.Router();

// Middleware to check validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Create meeting
router.post(
  '/',
  authenticate,
  body('meeting_type').isIn(['board_trustee', 'general', 'resolution']).withMessage('Invalid meeting type'),
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('date').isISO8601().withMessage('Valid date is required'),
  body('attendees').isArray().withMessage('Attendees must be an array'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.createMeeting(req, res);
    return result;
  })
);

// Get all meetings with filters
router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.getAllMeetings(req, res);
    return result;
  })
);

// Get meeting by ID
router.get(
  '/:meetingId',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.getMeetingById(req, res);
    return result;
  })
);

// Update meeting
router.put(
  '/:meetingId',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.updateMeeting(req, res);
    return result;
  })
);

// Update meeting status
router.patch(
  '/:meetingId/status',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  body('status').isIn(['scheduled', 'in_progress', 'completed', 'cancelled']).withMessage('Invalid status'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.updateMeetingStatus(req, res);
    return result;
  })
);

// Add meeting notes
router.post(
  '/:meetingId/notes',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  body('notes').trim().notEmpty().withMessage('Notes cannot be empty'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.addMeetingNotes(req, res);
    return result;
  })
);

// Update attendance
router.post(
  '/:meetingId/attendance',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  body('user_id').isMongoId().withMessage('Invalid user ID'),
  body('attendance_status').isIn(['invited', 'confirmed', 'declined', 'attended']).withMessage('Invalid attendance status'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.updateAttendance(req, res);
    return result;
  })
);

// Complete checklist item
router.post(
  '/:meetingId/checklist/:itemIndex',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  param('itemIndex').isInt({ min: 0 }).withMessage('Invalid item index'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.completeChecklistItem(req, res);
    return result;
  })
);

// Export for audit
router.post(
  '/:meetingId/export-audit',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.exportForAudit(req, res);
    return result;
  })
);

// Escalate to board
router.post(
  '/:meetingId/escalate',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.escalateToBoard(req, res);
    return result;
  })
);

// Delete meeting
router.delete(
  '/:meetingId',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.deleteMeeting(req, res);
    return result;
  })
);

// Add internal note
router.post(
  '/:meetingId/internal-notes',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  body('note').trim().notEmpty().withMessage('Note cannot be empty'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.addInternalNote(req, res);
    return result;
  })
);

// Get internal notes
router.get(
  '/:meetingId/internal-notes',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.getInternalNotes(req, res);
    return result;
  })
);

// Toggle important status
router.patch(
  '/:meetingId/important',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.toggleImportant(req, res);
    return result;
  })
);

// Update task status
router.patch(
  '/:meetingId/task-status',
  authenticate,
  param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
  body('task_status').isIn(['waiting', 'in_progress', 'in_review', 'approved']).withMessage('Invalid task status'),
  handleValidationErrors,
  asyncHandler(async (req, res) => {
    const controller = new MeetingController(req.user.org_id);
    const result = await controller.updateTaskStatus(req, res);
    return result;
  })
);

export default router;
