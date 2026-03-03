/**
 * Meeting Service
 * 
 * Business logic for meeting management
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { MeetingRepository } from '../repositories/meetingRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { getFileUrl } from '../services/s3Service.js';
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

    const meeting = await meetingRepo.create({
      org_id: this.orgId,
      created_by: createdBy,
      meeting_type: meetingData.meeting_type,
      title: meetingData.title,
      description: meetingData.description,
      date: meetingData.date,
      duration_minutes: meetingData.duration_minutes || 60,
      location: meetingData.location,
      meeting_link: meetingData.meeting_link,
      attendees: meetingData.attendees || [],
      external_attendees: meetingData.external_attendees || [],
      status: 'scheduled',
      recurrence_rule: meetingData.recurrence_rule || 'none',
      recurrence_series_id: meetingData.recurrence_series_id || null,
      board_meeting_info: meetingData.board_meeting_info || null,
      general_meeting_info: meetingData.general_meeting_info || null,
      resolution_meeting_info: meetingData.resolution_meeting_info || null
    });

    logInfo('Meeting created', { meetingId: meeting._id, type: meetingData.meeting_type, createdBy });

    if (meeting.meeting_type === 'board_trustee' && (meeting.recurrence_rule === 'monthly' || meeting.recurrence_rule === 'quarterly')) {
      await meetingRepo.update(meeting._id, { recurrence_series_id: meeting._id });
      meeting.recurrence_series_id = meeting._id;
    }

    // Send notifications and emails in background so API can return immediately and the modal can close
    const hasInternalAttendees = meeting.attendees && meeting.attendees.length > 0;
    const hasExternalAttendees = meeting.external_attendees && meeting.external_attendees.length > 0;

    if (hasInternalAttendees || hasExternalAttendees) {
      const meetingId = meeting._id;
      const tenantDbRef = tenantDb;
      const runInBackground = async () => {
        try {
          const notificationRepoBg = new NotificationRepository(tenantDbRef);
          const creatorUser = await userRepo.findById(createdBy);
          const creatorName = creatorUser ? `${creatorUser.first_name || ''} ${creatorUser.last_name || ''}`.trim() : 'Someone';

          const attendeeUserIds = meeting.attendees.map(a => a.user_id).filter(Boolean);
          const attendeeUsers = [];
          for (const userId of attendeeUserIds) {
            const user = await userRepo.findById(userId);
            if (user) attendeeUsers.push(user);
          }

          const internalNames = attendeeUsers.map(u => `${u.first_name || ''} ${u.last_name || ''}`.trim()).filter(Boolean);
          const externalNames = (meeting.external_attendees || []).map(ea => ea.name).filter(Boolean);
          const attendeeNames = [...internalNames, ...externalNames];

          const notifications = attendeeUserIds.map(uid => ({
            user_id: uid,
            type: 'meeting_invitation',
            title: 'Meeting Invitation',
            message: `You've been invited to "${meeting.title}" on ${new Date(meeting.date).toLocaleDateString()}`,
            link: `/meetings/${meetingId}`,
            related_entity_id: meetingId,
            related_entity_type: 'meeting'
          }));

          if (notifications.length > 0) {
            await notificationRepoBg.createMany(notifications);
            logInfo('Meeting notifications created', { meetingId, count: notifications.length });
          }

          const agenda = meetingData.agenda || [];
          for (const user of attendeeUsers) {
            if (user.email) {
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
                  meetingId: meetingId.toString()
                });
              } catch (emailErr) {
                logError('Failed to send meeting invitation email', emailErr, { userId: user._id });
              }
            }
          }

          for (const extAttendee of (meeting.external_attendees || [])) {
            if (extAttendee.email) {
              try {
                const result = await emailService.sendMeetingInvitationEmail({
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
                  meetingId: meetingId.toString(),
                  isExternal: true
                });
                if (result?.skipped) {
                  logInfo('Meeting invitation email skipped for external attendee', {
                    meetingId,
                    email: extAttendee.email,
                    reason: result.reason || 'unknown'
                  });
                } else {
                  logInfo('Meeting invitation email sent to external attendee', { meetingId, email: extAttendee.email });
                }
              } catch (emailErr) {
                logError('Failed to send meeting invitation email to external attendee', emailErr, {
                  email: extAttendee.email
                });
              }
            }
          }
        } catch (notifyErr) {
          logError('Failed to send meeting notifications', notifyErr, { meetingId });
        }
      };
      runInBackground().catch((err) => logError('Background meeting notifications/emails error', err, { meetingId: meeting._id }));
    }

    // Board/Trustee recurring: generate upcoming instances so they show for all
    if (meeting.meeting_type === 'board_trustee' && meeting.recurrence_rule && meeting.recurrence_rule !== 'none') {
      const seriesId = meeting._id;
      const runGenerate = async () => {
        try {
          const meetingRepoBg = new MeetingRepository(tenantDb);
          const baseDate = new Date(meeting.date);
          const count = meeting.recurrence_rule === 'monthly' ? 11 : 3;
          const addMonths = meeting.recurrence_rule === 'monthly' ? 1 : 3;
          for (let i = 1; i <= count; i++) {
            const nextDate = new Date(baseDate);
            nextDate.setMonth(nextDate.getMonth() + addMonths * i);
            await meetingRepoBg.create({
              org_id: meeting.org_id,
              created_by: createdBy,
              meeting_type: 'board_trustee',
              title: meeting.title,
              description: meeting.description,
              date: nextDate,
              duration_minutes: meeting.duration_minutes || 60,
              location: meeting.location,
              meeting_link: meeting.meeting_link,
              attendees: meeting.attendees || [],
              external_attendees: meeting.external_attendees || [],
              status: 'scheduled',
              recurrence_rule: meeting.recurrence_rule,
              recurrence_series_id: seriesId,
              board_meeting_info: meeting.board_meeting_info || meetingData.board_meeting_info || null
            });
          }
          logInfo('Recurring board meeting instances generated', { seriesId, count, rule: meeting.recurrence_rule });
        } catch (err) {
          logError('Generate recurring meeting instances failed', err, { meetingId: meeting._id });
        }
      };
      runGenerate().catch((e) => logError('Recurring instances error', e, { meetingId: meeting._id }));
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

    const meetingDocuments = meeting.meeting_documents || [];
    meetingDocuments.push({
      file_name: file.originalname,
      file_path: file.key || file.path,
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
}
