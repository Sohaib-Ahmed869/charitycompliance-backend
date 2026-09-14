import express from 'express';
import * as meetingController from '../../controllers/meetingController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

// Public RSVP route (no auth) - attendee clicks Accept/Decline in email
router.get(
  '/public/rsvp/:meetingId/:token/:response',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('token').notEmpty().withMessage('Token is required'),
    param('response').isIn(['accept', 'decline']).withMessage('Response must be accept or decline'),
  ],
  validate,
  meetingController.rsvpByToken
);

// All other meeting routes require authentication and tenant resolution.
// (The public RSVP route above runs without auth and without the feature gate.)
router.use(authAndResolveTenant);
router.use(requireFeatureFlag('governance.board_portal'));

// Create meeting
router.post(
  '/',
  [
    body('meeting_type').isIn(['board_trustee', 'general', 'resolution']).withMessage('Invalid meeting type'),
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('agenda').trim().notEmpty().withMessage('Agenda is required'),
    body('date').isISO8601().withMessage('Valid date is required'),
    body('attendees').isArray().withMessage('Attendees must be an array'),
  ],
  validate,
  meetingController.createMeeting
);

// Get all meetings with filters
router.get(
  '/',
  validate,
  meetingController.getMeetings
);

// Get meeting by ID
router.get(
  '/:meetingId',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.getMeetingById
);

// Update meeting
router.put(
  '/:meetingId',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.updateMeeting
);

// Cancel meeting — sets status=cancelled, stores reason, emails attendees
router.post(
  '/:meetingId/cancel',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    body('reason').optional({ nullable: true }).isString()
  ],
  validate,
  meetingController.cancelMeeting
);

// Add meeting notes
router.post(
  '/:meetingId/notes',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    body('notes').trim().notEmpty().withMessage('Notes cannot be empty'),
  ],
  validate,
  meetingController.addMeetingNotes
);

// Update attendance
router.post(
  '/:meetingId/attendance',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    body('user_id').isMongoId().withMessage('Invalid user ID'),
    body('attendance_status').isIn(['invited', 'confirmed', 'declined', 'attended']).withMessage('Invalid attendance status'),
  ],
  validate,
  meetingController.updateAttendance
);

// Complete checklist item
router.post(
  '/:meetingId/checklist/:itemIndex',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('itemIndex').isInt({ min: 0 }).withMessage('Invalid item index'),
  ],
  validate,
  meetingController.completeChecklistItem
);

// Export for audit
router.post(
  '/:meetingId/export-audit',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.exportForAudit
);

// Escalate to board
router.post(
  '/:meetingId/escalate',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.escalateToBoard
);

// Delete meeting
router.delete(
  '/:meetingId',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.deleteMeeting
);

// Add internal note
router.post(
  '/:meetingId/internal-notes',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    body('note').trim().notEmpty().withMessage('Note cannot be empty'),
  ],
  validate,
  meetingController.addInternalNote
);

// Get internal notes
router.get(
  '/:meetingId/internal-notes',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.getInternalNotes
);

// Toggle important status
router.patch(
  '/:meetingId/important',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.toggleImportant
);

// Update task status
router.patch(
  '/:meetingId/task-status',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    body('task_status').isIn(['waiting', 'in_progress', 'in_review', 'approved']).withMessage('Invalid task status'),
  ],
  validate,
  meetingController.updateTaskStatus
);

// Upload document to meeting
router.post(
  '/:meetingId/documents',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  uploadSingle,
  handleUploadError,
  meetingController.uploadDocument
);

// Stream meeting document (must be before GET /documents to avoid route collision)
router.get(
  '/:meetingId/documents/:documentIndex/stream',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('documentIndex').isInt({ min: 0 }).withMessage('Invalid document index'),
  ],
  validate,
  meetingController.streamMeetingDocument
);

// Get meeting documents
router.get(
  '/:meetingId/documents',
  [param('meetingId').isMongoId().withMessage('Invalid meeting ID')],
  validate,
  meetingController.getMeetingDocuments
);

// Delete meeting document
router.delete(
  '/:meetingId/documents/:documentId',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('documentId').isMongoId().withMessage('Invalid document ID'),
  ],
  validate,
  meetingController.deleteDocument
);

// Toggle note completion
router.patch(
  '/:meetingId/internal-notes/:noteId/toggle',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('noteId').isMongoId().withMessage('Invalid note ID'),
  ],
  validate,
  meetingController.toggleNoteCompletion
);

// Upload document to internal note
router.post(
  '/:meetingId/internal-notes/:noteId/documents',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('noteId').isMongoId().withMessage('Invalid note ID'),
  ],
  validate,
  uploadSingle,
  handleUploadError,
  meetingController.uploadNoteDocument
);

// Delete document from internal note
router.delete(
  '/:meetingId/internal-notes/:noteId/documents/:documentIndex',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('noteId').isMongoId().withMessage('Invalid note ID'),
    param('documentIndex').isInt({ min: 0 }).withMessage('Invalid document index'),
  ],
  validate,
  meetingController.deleteNoteDocument
);

// Stream internal note document
router.get(
  '/:meetingId/internal-notes/:noteId/documents/:documentIndex/stream',
  [
    param('meetingId').isMongoId().withMessage('Invalid meeting ID'),
    param('noteId').isMongoId().withMessage('Invalid note ID'),
    param('documentIndex').isInt({ min: 0 }).withMessage('Invalid document index'),
  ],
  validate,
  meetingController.streamNoteDocument
);

export default router;
