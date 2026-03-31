/**
 * Meeting Repository
 * 
 * Data access layer for meetings
 */

import meetingSchema from '../db/schemas/platform/meetingSchema.js';

export class MeetingRepository {
  constructor(tenantDb) {
    this.tenantDb = tenantDb;
    this.Meeting = tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);
  }

  async create(meetingData) {
    const meeting = new this.Meeting(meetingData);
    return await meeting.save();
  }

  async findById(meetingId) {
    return await this.Meeting.findById(meetingId)
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .populate('completion_audit.completed_by', 'first_name last_name email')
      .lean();
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };

    if (filters.meeting_type) {
      query.meeting_type = filters.meeting_type;
    }
    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.startDate && filters.endDate) {
      query.date = {
        $gte: new Date(filters.startDate),
        $lte: new Date(filters.endDate)
      };
    }

    return await this.Meeting.find(query)
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .populate('completion_audit.completed_by', 'first_name last_name email')
      .sort({ date: -1 })
      .lean();
  }

  async update(meetingId, updateData) {
    return await this.Meeting.findByIdAndUpdate(
      meetingId,
      updateData,
      { new: true }
    )
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .populate('completion_audit.completed_by', 'first_name last_name email')
      .lean();
  }

  async updateAttendance(meetingId, userId, status) {
    const shouldStampRsvp = ['confirmed', 'declined'].includes(status);
    return await this.Meeting.findByIdAndUpdate(
      meetingId,
      {
        $set: {
          'attendees.$[elem].attendance_status': status,
          ...(shouldStampRsvp ? { 'attendees.$[elem].rsvp_at': new Date() } : {})
        }
      },
      {
        new: true,
        arrayFilters: [{ 'elem.user_id': userId }]
      }
    )
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .lean();
  }

  /**
   * Update attendance by RSVP token (internal or external attendee)
   * @param {string} meetingId
   * @param {string} token
   * @param {'confirmed'|'declined'} status
   */
  async updateAttendanceByToken(meetingId, token, status) {
    if (!token || !['confirmed', 'declined'].includes(status)) return null;

    const now = new Date();
    // Try attendees first
    const byAttendee = await this.Meeting.findOneAndUpdate(
      { _id: meetingId, 'attendees.rsvp_token': token },
      { $set: { 'attendees.$[elem].attendance_status': status, 'attendees.$[elem].rsvp_at': now } },
      { new: true, arrayFilters: [{ 'elem.rsvp_token': token }] }
    )
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .lean();

    if (byAttendee) return byAttendee;

    // Try external_attendees
    return await this.Meeting.findByIdAndUpdate(
      meetingId,
      { $set: { 'external_attendees.$[elem].attendance_status': status, 'external_attendees.$[elem].rsvp_at': now } },
      { new: true, arrayFilters: [{ 'elem.rsvp_token': token }] }
    )
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .lean();
  }

  async completeChecklistItem(meetingId, itemIndex) {
    return await this.Meeting.findByIdAndUpdate(
      meetingId,
      {
        $set: {
          [`board_meeting_info.compliance_checklist.${itemIndex}.completed`]: true,
          [`board_meeting_info.compliance_checklist.${itemIndex}.checked_at`]: new Date()
        }
      },
      { new: true }
    )
      .populate('created_by', 'first_name last_name email')
      .populate('attendees.user_id', 'first_name last_name email')
      .lean();
  }

  async delete(meetingId) {
    return await this.Meeting.findByIdAndDelete(meetingId);
  }
}
