/**
 * Meeting Service
 * 
 * Business logic for meeting management
 */

import crypto from 'crypto';
import { getTenantConnection } from '../db/connectionManager.js';
import { registerMeetingOrgLookup } from '../db/router.js';
import { MeetingRepository } from '../repositories/meetingRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { getFileUrl, getFileStream, uploadToS3 } from '../services/s3Service.js';
import emailService from '../services/emailService.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';

export class MeetingService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async attachProfilePictures(meetings) {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const boardMembers = await boardMemberRepo.findByOrgId(org._id);
    const boardMemberByUserId = new Map(
      boardMembers.map((bm) => [bm.user_id?.toString(), bm])
    );

    const resolveAvatarUrl = async (user) => {
      if (!user) return user;
      const userId = user._id?.toString?.() || user.id?.toString?.();
      const boardMember = userId ? boardMemberByUserId.get(userId) : null;
      const profileKey = boardMember?.profile_picture_key || user.profile_picture_key || null;

      if (!profileKey) return { ...user, avatar: user.avatar || null };

      try {
        const avatarUrl = await getFileUrl(profileKey, 604800);
        return { ...user, avatar: avatarUrl };
      } catch (err) {
        return { ...user, avatar: user.avatar || null };
      }
    };

    const enrichMeeting = async (meeting) => {
      if (!meeting) return meeting;
      const createdBy = await resolveAvatarUrl(meeting.created_by);
      const attendees = await Promise.all((meeting.attendees || []).map(async (attendee) => {
        if (!attendee?.user_id) return attendee;
        const enrichedUser = await resolveAvatarUrl(attendee.user_id);
        return { ...attendee, user_id: enrichedUser };
      }));

      return { ...meeting, created_by: createdBy, attendees };
    };

    if (Array.isArray(meetings)) {
      return Promise.all(meetings.map(enrichMeeting));
    }
    return enrichMeeting(meetings);
  }

  /**
   * Create a new meeting
   */
  async createMeeting(meetingData, createdBy) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    // Generate RSVP tokens for attendees
    const attendeesWithTokens = (meetingData.attendees || []).map(a => ({
      user_id: a.user_id,
      attendance_status: 'invited',
      rsvp_token: crypto.randomBytes(32).toString('hex')
    }));
    const externalWithTokens = (meetingData.external_attendees || []).map(e => ({
      ...e,
      attendance_status: 'invited',
      rsvp_token: crypto.randomBytes(32).toString('hex')
    }));

    const meeting = await meetingRepo.create({
      org_id: this.orgId,
      created_by: createdBy,
      meeting_type: meetingData.meeting_type,
      title: meetingData.title,
      agenda: meetingData.agenda,
      date: meetingData.date,
      duration_minutes: meetingData.duration_minutes || 60,
      location: meetingData.location,
      meeting_link: meetingData.meeting_link,
      attendees: attendeesWithTokens,
      external_attendees: externalWithTokens,
      status: 'scheduled',
      board_meeting_info: meetingData.board_meeting_info || null,
      general_meeting_info: meetingData.general_meeting_info || null,
      resolution_meeting_info: meetingData.resolution_meeting_info || null
    });

    logInfo('Meeting created', { meetingId: meeting._id, type: meetingData.meeting_type, createdBy });

    // Register meeting->org for public RSVP lookup
    await registerMeetingOrgLookup(meeting._id.toString(), this.orgId);

    // Send notifications and emails to attendees
    const hasInternalAttendees = meeting.attendees && meeting.attendees.length > 0;
    const hasExternalAttendees = meeting.external_attendees && meeting.external_attendees.length > 0;
    
    if (hasInternalAttendees || hasExternalAttendees) {
      try {
        // Get creator info
        const creatorUser = await userRepo.findById(createdBy);
        const creatorName = creatorUser ? `${creatorUser.first_name || ''} ${creatorUser.last_name || ''}`.trim() : 'Someone';

        // Get all internal attendee user IDs
        const attendeeUserIds = meeting.attendees.map(a => a.user_id).filter(Boolean);

        // Fetch all internal attendee users
        const attendeeUsers = [];
        for (const userId of attendeeUserIds) {
          const user = await userRepo.findById(userId);
          if (user) attendeeUsers.push(user);
        }

        // Get all attendee names for email (internal + external)
        const internalNames = attendeeUsers.map(u => `${u.first_name || ''} ${u.last_name || ''}`.trim()).filter(Boolean);
        const externalNames = (meeting.external_attendees || []).map(ea => ea.name).filter(Boolean);
        const attendeeNames = [...internalNames, ...externalNames];

        // Create notifications for all attendees
        const notifications = attendeeUserIds.map(userId => ({
          user_id: userId,
          type: 'meeting_invitation',
          title: 'Meeting Invitation',
          message: `You've been invited to "${meeting.title}" on ${new Date(meeting.date).toLocaleDateString()}`,
          link: `/meetings/${meeting._id}`,
          related_entity_id: meeting._id,
          related_entity_type: 'meeting'
        }));

        if (notifications.length > 0) {
          await notificationRepo.createMany(notifications);
          logInfo('Meeting notifications created', { meetingId: meeting._id, count: notifications.length });
        }

        // Send emails to internal attendees
        const agenda = meetingData.agenda || [];
        const attendeeByUserId = new Map((meeting.attendees || []).map(a => [a.user_id?.toString(), a]));
        for (const user of attendeeUsers) {
          if (user.email) {
            const attendeeRec = attendeeByUserId.get(user._id.toString());
            const rsvpToken = attendeeRec?.rsvp_token;
            try {
              await emailService.sendMeetingInvitationEmail({
                to: user.email,
                recipientName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Team Member',
                meetingTitle: meeting.title,
                meetingDate: meeting.date,
                durationMinutes: meeting.duration_minutes,
                location: meeting.location,
                meetingLink: meeting.meeting_link,
                agenda,
                attendeeNames,
                organizerName: creatorName,
                meetingId: meeting._id.toString(),
                rsvpToken
              });
            } catch (emailErr) {
              logError('Failed to send meeting invitation email', emailErr, { userId: user._id });
            }
          }
        }

        // Send emails to external attendees
        for (const extAttendee of (meeting.external_attendees || [])) {
          if (extAttendee.email) {
            try {
              await emailService.sendMeetingInvitationEmail({
                to: extAttendee.email,
                recipientName: extAttendee.name || 'Guest',
                meetingTitle: meeting.title,
                meetingDate: meeting.date,
                durationMinutes: meeting.duration_minutes,
                location: meeting.location,
                meetingLink: meeting.meeting_link,
                agenda,
                attendeeNames,
                organizerName: creatorName,
                meetingId: meeting._id.toString(),
                isExternal: true,
                rsvpToken: extAttendee.rsvp_token
              });
              logInfo('Meeting invitation email sent to external attendee', { 
                meetingId: meeting._id, 
                email: extAttendee.email 
              });
            } catch (emailErr) {
              logError('Failed to send meeting invitation email to external attendee', emailErr, { 
                email: extAttendee.email 
              });
            }
          }
        }
      } catch (notifyErr) {
        logError('Failed to send meeting notifications', notifyErr, { meetingId: meeting._id });
      }
    }

    return meeting;
  }

  /**
   * Get all meetings with filters
   */
  async getMeetings(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);
    const meetings = await meetingRepo.findByOrgId(this.orgId, filters);
    return await this.attachProfilePictures(meetings);
  }

  /**
   * Get meeting by ID with signed document URLs
   */
  async getMeetingById(meetingId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const meetingWithPictures = await this.attachProfilePictures(meeting);
    
    // Generate signed URLs for meeting documents
    if (meetingWithPictures.meeting_documents && meetingWithPictures.meeting_documents.length > 0) {
      const documentsWithUrls = await Promise.all(
        meetingWithPictures.meeting_documents.map(async (doc) => {
          try {
            const url = await getFileUrl(doc.file_path, 3600);
            return {
              ...doc.toObject ? doc.toObject() : doc,
              url
            };
          } catch (err) {
            return {
              ...doc.toObject ? doc.toObject() : doc,
              url: null
            };
          }
        })
      );
      meetingWithPictures.meeting_documents = documentsWithUrls;
    }

    // Generate signed URLs for internal notes documents
    if (meetingWithPictures.internal_notes && meetingWithPictures.internal_notes.length > 0) {
      meetingWithPictures.internal_notes = await Promise.all(
        meetingWithPictures.internal_notes.map(async (note) => {
          const noteObj = note.toObject ? note.toObject() : { ...note };
          
          if (noteObj.documents && noteObj.documents.length > 0) {
            const docsWithUrls = await Promise.all(
              noteObj.documents.map(async (doc) => {
                try {
                  const docObj = doc.toObject ? doc.toObject() : { ...doc };
                  const url = await getFileUrl(docObj.file_path, 3600);
                  return {
                    ...docObj,
                    url
                  };
                } catch (err) {
                  logError('Failed to generate URL for note document', err, { documentId: doc._id });
                  return {
                    ...doc.toObject ? doc.toObject() : { ...doc },
                    url: null
                  };
                }
              })
            );
            return {
              ...noteObj,
              documents: docsWithUrls
            };
          }
          return noteObj;
        })
      );
    }

    return meetingWithPictures;
  }

  /**
   * Add notes to meeting
   */
  async addMeetingNotes(meetingId, notes) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    return await meetingRepo.update(meetingId, {
      meeting_notes: notes,
      updated_at: new Date()
    });
  }

  /**
   * RSVP by token (public - no auth) - used when attendee clicks Accept/Decline in email
   */
  async rsvpByToken(meetingId, token, response) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const status = response === 'accept' ? 'confirmed' : 'declined';
    const updated = await meetingRepo.updateAttendanceByToken(meetingId, token, status);
    if (!updated) {
      throw new AppError('Invalid or expired RSVP link', 400, 'INVALID_RSVP_TOKEN');
    }
    return updated;
  }

  /**
   * Update attendance status
   */
  async updateAttendance(meetingId, userId, status) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    // Validate status
    const validStatuses = ['invited', 'confirmed', 'declined', 'attended'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid attendance status', 400, 'INVALID_STATUS');
    }

    return await meetingRepo.updateAttendance(meetingId, userId, status);
  }

  /**
   * Complete compliance checklist item
   */
  async completeChecklistItem(meetingId, itemIndex) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    if (!meeting.board_meeting_info?.compliance_checklist) {
      throw new AppError('This meeting does not have a compliance checklist', 400, 'NO_CHECKLIST');
    }

    if (itemIndex < 0 || itemIndex >= meeting.board_meeting_info.compliance_checklist.length) {
      throw new AppError('Invalid checklist item index', 400, 'INVALID_INDEX');
    }

    return await meetingRepo.completeChecklistItem(meetingId, itemIndex);
  }

  /**
   * Update meeting status
   */
  async updateMeetingStatus(meetingId, status) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const validStatuses = ['scheduled', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      throw new AppError('Invalid meeting status', 400, 'INVALID_STATUS');
    }

    const updateData = { status, updated_at: new Date() };

    if (status === 'completed') {
      updateData.completed_at = new Date();
    } else if (status === 'cancelled') {
      updateData.cancelled_at = new Date();
    }

    return await meetingRepo.update(meetingId, updateData);
  }

  /**
   * Export meeting for audit
   */
  async exportForAudit(meetingId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    return await meetingRepo.update(meetingId, {
      is_exported_for_audit: true,
      exported_at: new Date()
    });
  }

  /**
   * Delete meeting
   */
  async deleteMeeting(meetingId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    logInfo('Meeting deleted', { meetingId, type: meeting.meeting_type });

    return await meetingRepo.delete(meetingId);
  }

  /**
   * Escalate resolution meeting to board
   */
  async escalateToBoard(meetingId, userId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    if (meeting.meeting_type !== 'resolution') {
      throw new AppError('Only resolution meetings can be escalated', 400, 'INVALID_TYPE');
    }

    logInfo('Meeting escalated to board', { meetingId, escalatedBy: userId });

    return await meetingRepo.update(meetingId, {
      'resolution_meeting_info.requires_board_escalation': true,
      'resolution_meeting_info.escalated_to_board_at': new Date(),
      'resolution_meeting_info.resolution_status': 'escalated'
    });
  }

  /**
   * Add internal note to meeting
   */
  async addInternalNote(meetingId, note, userId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);
    const notificationRepo = new NotificationRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const internalNotes = meeting.internal_notes || [];
    internalNotes.push({
      note,
      added_by: userId,
      added_at: new Date()
    });

    logInfo('Internal note added to meeting', { meetingId, userId });

    const updatedMeeting = await meetingRepo.update(meetingId, {
      internal_notes: internalNotes,
      updated_at: new Date()
    });

    // Send email notifications to all attendees
    if (meeting.attendees && meeting.attendees.length > 0) {
      try {
        // Get the user who added the note
        const addedByUser = await userRepo.findById(userId);
        const addedByName = addedByUser ? `${addedByUser.first_name || ''} ${addedByUser.last_name || ''}`.trim() : 'Someone';

        // Get all attendee user IDs
        const attendeeUserIds = meeting.attendees.map(a => a.user_id).filter(Boolean);

        // Create notifications for attendees
        const notifications = attendeeUserIds.map(uid => ({
          user_id: uid,
          type: 'meeting_notes_added',
          title: 'Meeting Notes Updated',
          message: `${addedByName} added a note to "${meeting.title}"`,
          link: `/meetings/${meeting._id}?tab=notes`,
          related_entity_id: meeting._id,
          related_entity_type: 'meeting'
        }));

        if (notifications.length > 0) {
          await notificationRepo.createMany(notifications);
        }

        // Send emails to attendees
        for (const uid of attendeeUserIds) {
          const user = await userRepo.findById(uid);
          if (user && user.email) {
            try {
              await emailService.sendMeetingNotesEmail({
                to: user.email,
                recipientName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Team Member',
                meetingTitle: meeting.title,
                noteContent: note,
                addedByName,
                meetingId: meeting._id.toString()
              });
            } catch (emailErr) {
              logError('Failed to send meeting notes email', emailErr, { userId: uid });
            }
          }
        }
      } catch (notifyErr) {
        logError('Failed to send meeting notes notifications', notifyErr, { meetingId });
      }
    }

    return updatedMeeting;
  }

  /**
   * Get internal notes for a meeting
   */
  async getInternalNotes(meetingId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    return meeting.internal_notes || [];
  }

  /**
   * Toggle meeting important status
   */
  async toggleImportant(meetingId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    return await meetingRepo.update(meetingId, {
      is_important: !meeting.is_important,
      updated_at: new Date()
    });
  }

  /**
   * Update meeting task status
   */
  async updateTaskStatus(meetingId, taskStatus) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const validStatuses = ['waiting', 'in_progress', 'in_review', 'approved'];
    if (!validStatuses.includes(taskStatus)) {
      throw new AppError('Invalid task status', 400, 'INVALID_TASK_STATUS');
    }

    return await meetingRepo.update(meetingId, {
      task_status: taskStatus,
      updated_at: new Date()
    });
  }

  /**
   * Upload document to meeting
   */
  async uploadDocument(meetingId, file, userId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    let key = file.key || file.path;
    if (!key && file.buffer) {
      const result = await uploadToS3(file.buffer, file.originalname, file.mimetype, this.orgId, 'meetings');
      key = result.key;
    }
    if (!key) {
      throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
    }

    const meetingDocuments = meeting.meeting_documents || [];
    meetingDocuments.push({
      file_name: file.originalname,
      file_path: key,
      file_size: file.size,
      mime_type: file.mimetype,
      uploaded_by: userId,
      uploaded_at: new Date()
    });

    logInfo('Document uploaded to meeting', { meetingId, fileName: file.originalname });

    return await meetingRepo.update(meetingId, {
      meeting_documents: meetingDocuments,
      updated_at: new Date()
    });
  }

  /**
   * Get meeting documents with signed URLs
   */
  async getMeetingDocuments(meetingId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const documents = meeting.meeting_documents || [];
    
    // Generate signed URLs for each document
    const documentsWithUrls = await Promise.all(
      documents.map(async (doc) => {
        try {
          const url = await getFileUrl(doc.file_path, 3600); // 1 hour expiry
          return {
            ...doc.toObject ? doc.toObject() : doc,
            url
          };
        } catch (err) {
          logError('Failed to generate URL for document', err, { documentId: doc._id });
          return {
            ...doc.toObject ? doc.toObject() : doc,
            url: null
          };
        }
      })
    );

    return documentsWithUrls;
  }

  /**
   * Delete meeting document
   */
  async deleteDocument(meetingId, documentId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const meetingDocuments = (meeting.meeting_documents || []).filter(
      doc => doc._id.toString() !== documentId
    );

    return await meetingRepo.update(meetingId, {
      meeting_documents: meetingDocuments,
      updated_at: new Date()
    });
  }

  /**
   * Toggle internal note completion
   */
  async toggleNoteCompletion(meetingId, noteId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const internalNotes = meeting.internal_notes || [];
    const noteIndex = internalNotes.findIndex(n => n._id.toString() === noteId);
    
    if (noteIndex === -1) {
      throw new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
    }

    internalNotes[noteIndex].completed = !internalNotes[noteIndex].completed;

    return await meetingRepo.update(meetingId, {
      internal_notes: internalNotes,
      updated_at: new Date()
    });
  }

  /**
   * Upload a document to a specific internal note
   */
  async uploadNoteDocument(meetingId, noteId, file, userId) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const internalNotes = meeting.internal_notes || [];
    const noteIndex = internalNotes.findIndex(n => n._id.toString() === noteId);
    
    if (noteIndex === -1) {
      throw new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
    }

    // Initialize documents array if it doesn't exist
    if (!internalNotes[noteIndex].documents) {
      internalNotes[noteIndex].documents = [];
    }

    let key = file.key || file.path;
    if (!key && file.buffer) {
      const result = await uploadToS3(file.buffer, file.originalname, file.mimetype, this.orgId, 'meetings');
      key = result.key;
    }
    if (!key) {
      throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
    }

    // Add the document to the note's documents array
    internalNotes[noteIndex].documents.push({
      file_name: file.originalname,
      file_path: key,
      file_size: file.size,
      mime_type: file.mimetype,
      uploaded_at: new Date()
    });

    logInfo('Document uploaded to internal note', { meetingId, noteId, fileName: file.originalname });

    return await meetingRepo.update(meetingId, {
      internal_notes: internalNotes,
      updated_at: new Date()
    });
  }

  /**
   * Stream meeting document by index
   */
  async streamMeetingDocument(meetingId, documentIndex, rangeHeader = null) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);
    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }
    const docs = meeting.meeting_documents || [];
    const doc = docs[documentIndex];
    if (!doc?.file_path) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    return getFileStream(doc.file_path, rangeHeader);
  }

  /**
   * Stream internal note document by noteId and documentIndex
   */
  async streamNoteDocument(meetingId, noteId, documentIndex, rangeHeader = null) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);
    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }
    const noteIndex = (meeting.internal_notes || []).findIndex(n => n._id.toString() === noteId);
    if (noteIndex === -1 || !meeting.internal_notes[noteIndex].documents?.[documentIndex]) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    const doc = meeting.internal_notes[noteIndex].documents[documentIndex];
    if (!doc?.file_path) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }
    return getFileStream(doc.file_path, rangeHeader);
  }

  /**
   * Delete a document from an internal note
   */
  async deleteNoteDocument(meetingId, noteId, documentIndex) {
    const tenantDb = await this.getTenantDb();
    const meetingRepo = new MeetingRepository(tenantDb);

    const meeting = await meetingRepo.findById(meetingId);
    if (!meeting) {
      throw new AppError('Meeting not found', 404, 'MEETING_NOT_FOUND');
    }

    const internalNotes = meeting.internal_notes || [];
    const noteIndex = internalNotes.findIndex(n => n._id.toString() === noteId);
    
    if (noteIndex === -1) {
      throw new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
    }

    if (!internalNotes[noteIndex].documents || !internalNotes[noteIndex].documents[documentIndex]) {
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    }

    // Remove the document
    internalNotes[noteIndex].documents.splice(documentIndex, 1);

    logInfo('Document deleted from internal note', { meetingId, noteId, documentIndex });

    return await meetingRepo.update(meetingId, {
      internal_notes: internalNotes,
      updated_at: new Date()
    });
  }
}
