/**
 * Meeting Controller
 * 
 * HTTP request handlers for meeting operations
 */

import { MeetingService } from '../services/meetingService.js';
import { getOrgByMeetingId } from '../db/router.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';

/**
 * Public RSVP - no auth. Attendee clicks Accept/Decline link in email.
 * Redirects to frontend confirmation page.
 */
export const rsvpByToken = asyncHandler(async (req, res) => {
  const { meetingId, token, response } = req.params;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (!['accept', 'decline'].includes(response)) {
    return res.redirect(`${frontendUrl}/meetings/rsvp-done?error=invalid`);
  }

  const orgId = await getOrgByMeetingId(meetingId);
  if (!orgId) {
    return res.redirect(`${frontendUrl}/meetings/rsvp-done?error=not_found`);
  }

  const meetingService = new MeetingService(orgId);
  await meetingService.rsvpByToken(meetingId, token, response);

  const status = response === 'accept' ? 'accepted' : 'declined';
  return res.redirect(`${frontendUrl}/meetings/rsvp-done?status=${status}&meetingId=${meetingId}`);
});

export const createMeeting = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user.userId;
  const meetingData = req.body;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.createMeeting(meetingData, userId);

  res.status(201).json({
    success: true,
    data: meeting
  });
});

export const getMeetings = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    meeting_type: req.query.meeting_type,
    status: req.query.status,
    startDate: req.query.startDate,
    endDate: req.query.endDate
  };

  const meetingService = new MeetingService(orgId);
  const meetings = await meetingService.getMeetings(filters);

  res.json({
    success: true,
    data: meetings
  });
});

export const getMeetingById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.getMeetingById(meetingId);

  res.json({
    success: true,
    data: meeting
  });
});

export const updateMeeting = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { meetingId } = req.params;
  const updateData = req.body;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.getMeetingById(meetingId);

  if (!meeting) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Meeting not found' }
    });
  }

  // Handle status update with completion audit
  if (updateData.status) {
    let statusUpdateData = { status: updateData.status };
    
    // If completing meeting, add completion audit with signature
    if (updateData.status === 'completed') {
      statusUpdateData.completion_audit = {
        completed_by: userId,
        completed_at: new Date(),
        completion_signature: updateData.completion_signature || null,
        completion_checklist_snapshot: updateData.completion_checklist_snapshot || []
      };
    }
    
    const updated = await meetingService.updateMeetingStatus(meetingId, statusUpdateData);
    return res.json({
      success: true,
      data: updated
    });
  }

  // Non-status patch: write the allowed fields the FE is permitted to update
  // (currently only board_meeting_info — used for adding agenda items mid-meeting
  // and toggling `selected` flags on the compliance checklist).
  const allowedFields = ['board_meeting_info', 'agenda', 'title', 'meeting_link', 'location'];
  const patch = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(updateData, key)) patch[key] = updateData[key];
  }

  if (Object.keys(patch).length === 0) {
    return res.json({ success: true, data: meeting });
  }

  patch.updated_at = new Date();
  const { MeetingRepository } = await import('../repositories/meetingRepository.js');
  const { getTenantConnection } = await import('../db/connectionManager.js');
  const tenantDb = await getTenantConnection(orgId);
  const meetingRepo = new MeetingRepository(tenantDb);
  const updated = await meetingRepo.update(meetingId, patch);

  return res.json({ success: true, data: updated });
});

export const addMeetingNotes = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;
  const { notes } = req.body;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.addMeetingNotes(meetingId, notes);

  res.json({
    success: true,
    data: meeting
  });
});

export const updateAttendance = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;
  const { userId, status } = req.body;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.updateAttendance(meetingId, userId, status);

  res.json({
    success: true,
    data: meeting
  });
});

export const completeChecklistItem = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId, itemIndex } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.completeChecklistItem(meetingId, parseInt(itemIndex));

  res.json({
    success: true,
    data: meeting
  });
});

export const exportForAudit = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.exportForAudit(meetingId);

  res.json({
    success: true,
    data: meeting,
    message: 'Meeting exported for audit'
  });
});

export const escalateToBoard = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.escalateToBoard(meetingId, userId);

  res.json({
    success: true,
    data: meeting,
    message: 'Meeting escalated to board'
  });
});

export const deleteMeeting = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  await meetingService.deleteMeeting(meetingId);

  res.json({
    success: true,
    message: 'Meeting deleted successfully'
  });
});

export const addInternalNote = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { meetingId } = req.params;
  const { note } = req.body;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.addInternalNote(meetingId, note, userId);

  res.json({
    success: true,
    data: meeting
  });
});

export const getInternalNotes = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  const notes = await meetingService.getInternalNotes(meetingId);

  res.json({
    success: true,
    data: notes
  });
});

export const toggleImportant = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.toggleImportant(meetingId);

  res.json({
    success: true,
    data: meeting
  });
});

export const updateTaskStatus = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;
  const { task_status } = req.body;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.updateTaskStatus(meetingId, task_status);

  res.json({
    success: true,
    data: meeting
  });
});

export const uploadDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { meetingId } = req.params;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: { code: 'FILE_REQUIRED', message: 'File is required' }
    });
  }

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.uploadDocument(meetingId, req.file, userId);

  res.json({
    success: true,
    data: meeting,
    message: 'Document uploaded successfully'
  });
});

export const getMeetingDocuments = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId } = req.params;

  const meetingService = new MeetingService(orgId);
  const documents = await meetingService.getMeetingDocuments(meetingId);

  res.json({
    success: true,
    data: documents
  });
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId, documentId } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.deleteDocument(meetingId, documentId);

  res.json({
    success: true,
    data: meeting,
    message: 'Document deleted successfully'
  });
});

export const toggleNoteCompletion = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId, noteId } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.toggleNoteCompletion(meetingId, noteId);

  res.json({
    success: true,
    data: meeting
  });
});

export const uploadNoteDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user.userId;
  const { meetingId, noteId } = req.params;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: { code: 'FILE_REQUIRED', message: 'File is required' }
    });
  }

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.uploadNoteDocument(meetingId, noteId, req.file, userId);

  res.json({
    success: true,
    data: meeting,
    message: 'Document uploaded to note successfully'
  });
});

export const deleteNoteDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId, noteId, documentIndex } = req.params;

  const meetingService = new MeetingService(orgId);
  const meeting = await meetingService.deleteNoteDocument(meetingId, noteId, parseInt(documentIndex));

  res.json({
    success: true,
    data: meeting,
    message: 'Document deleted from note successfully'
  });
});

/** Stream meeting document for viewing/download */
export const streamMeetingDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId, documentIndex } = req.params;
  const meetingService = new MeetingService(orgId);
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await meetingService.streamMeetingDocument(meetingId, parseInt(documentIndex, 10), req.headers.range || null);
  res.setHeader('Content-Type', ContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});

/** Stream internal note document for viewing/download */
export const streamNoteDocument = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { meetingId, noteId, documentIndex } = req.params;
  const meetingService = new MeetingService(orgId);
  const { Body, ContentType, ContentLength, ContentRange, IsPartial } = await meetingService.streamNoteDocument(meetingId, noteId, parseInt(documentIndex, 10), req.headers.range || null);
  res.setHeader('Content-Type', ContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');
  if (IsPartial && ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', ContentRange);
  }
  if (ContentLength != null) res.setHeader('Content-Length', String(ContentLength));
  Body.pipe(res);
});
