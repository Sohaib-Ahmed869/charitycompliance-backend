/**
 * Calendar Controller
 * Handles calendar events for logged-in users including policy expiry, training deadlines, and custom events
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { CalendarRepository } from '../repositories/calendarRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';

/** Normalize a date to ISO string for consistent client handling */
const toISODate = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Helper function to format an event for calendar display
 */
const formatCalendarEvent = (event, type, sourceId = null) => {
  const date = event.date || event.review_date || event.term_end_date || event.end_date;
  return {
    id: event._id?.toString() || sourceId,
    _id: event._id,
    title: event.title,
    date: toISODate(date) || date,
    type,
    description: event.description || `${type} event`,
    is_custom: false,
    source: type
  };
};

/**
 * Get all calendar events for the logged-in user
 * Includes: custom events, policy review dates, training renewals, board member term ends, and funding agreement ends
 */
export const getCalendarEvents = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const orgId = req.orgId; // tenant slug (e.g. "shahid_afridi_foundation")
  const { start_date, end_date } = req.query;

  const tenantDb = await getTenantConnection(orgId);
  const calendarRepo = new CalendarRepository(tenantDb);

  // Resolve org ObjectId from tenant DB (Policy/Training/Funding use org_id as ObjectId, not slug)
  let orgObjectId = null;
  try {
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (org && org._id) orgObjectId = org._id;
  } catch (err) {
    logError('Calendar: could not resolve org', { orgId, error: err.message });
  }

  const dateOptions = { start_date, end_date };

  // Get custom events (created by user) - always try this first
  let customEvents = [];
  let policyEvents = [];
  let trainingEvents = [];
  let boardMemberEvents = [];
  let fundingEvents = [];
  let documentEvents = [];

  try {
    customEvents = await calendarRepo.findByUserId(userId, dateOptions);
    logInfo('Custom events retrieved', { userId, count: customEvents.length });
  } catch (error) {
    logError('Error retrieving custom events', { userId, error: error.message });
  }

  if (orgObjectId) {
  try {
    // Get policy review events (review_date as calendar event)
    const policyReviews = await calendarRepo.findUpcomingPolicyReviews(orgObjectId, dateOptions);
    logInfo('Policy reviews found', { orgId, count: policyReviews.length, sample: policyReviews[0] });
    policyEvents = policyReviews.map(p => formatCalendarEvent(
      { ...p, title: `${p.title} - Review Due`, date: p.review_date },
      'policy',
      p._id?.toString()
    ));
    logInfo('Policy events retrieved', { orgId, count: policyEvents.length });
  } catch (error) {
    logError('Error retrieving policy events', { orgId, error: error.message, stack: error.stack });
  }

  try {
    // Training renewals from enrollments (completed_at + renewal_months per user)
    const trainingRenewals = await calendarRepo.findUpcomingTrainingRenewals(userId, dateOptions);
    const enrollmentTrainingEvents = trainingRenewals.map(t => ({
      ...t,
      _id: t._id,
      id: t._id?.toString(),
      type: 'training',
      is_custom: false,
      source: 'training'
    }));
    // Training program renewal events: published_at/createdAt + renewal_months (org-wide)
    const programRenewalEvents = await calendarRepo.findTrainingProgramRenewalEvents(orgObjectId, dateOptions);
   
    trainingEvents = [...enrollmentTrainingEvents, ...programRenewalEvents];
   
  } catch (error) {
    logError('Error retrieving training events', { userId, orgId, error: error.message, stack: error.stack });
  }

  try {
    // Get board member term ends (org-wide)
    const memberTermEnds = await calendarRepo.findUpcomingBoardMemberTermEnds(orgObjectId, dateOptions);
    boardMemberEvents = memberTermEnds.map(m => formatCalendarEvent(
      {
        ...m,
        title: `${m.given_names} ${m.family_name} (${m.position}) - Term Ends`,
        date: m.term_end_date
      },
      'compliance',
      m._id?.toString()
    ));
    logInfo('Board member events retrieved', { orgId, count: boardMemberEvents.length });
  } catch (error) {
    logError('Error retrieving board member events', { orgId, error: error.message });
  }

  try {
    // Get funding agreement end dates (org-wide)
    const fundingEnds = await calendarRepo.findUpcomingFundingAgreementEnds(orgObjectId, dateOptions);
    logInfo('Funding agreements found', { orgId, count: fundingEnds.length, sample: fundingEnds[0] });
    fundingEvents = fundingEnds.map(f => formatCalendarEvent(
      {
        ...f,
        title: `${f.agreement_title} (${f.partner_name}) - Ends`,
        date: f.end_date
      },
      'funding',
      f._id?.toString()
    ));
   
  } catch (error) {
    logError('Error retrieving funding events', { orgId, error: error.message, stack: error.stack });
  }

  try {
    // Governing documents & registration/license expiries (org-wide)
    const documentExpiries = await calendarRepo.findUpcomingDocumentExpiries(orgObjectId, dateOptions);
    documentEvents = documentExpiries.map((d) => formatCalendarEvent(
      {
        ...d,
        title: `${d.title || d.document_type} - Expires`,
        date: d.expiry_date,
        description: d.document_type || d.category
      },
      'compliance',
      d._id?.toString()
    ));
    logInfo('Document expiry events retrieved', { orgId, count: documentEvents.length });
  } catch (error) {
    logError('Error retrieving document expiry events', { orgId, error: error.message, stack: error.stack });
  }
  } // if (orgObjectId)

  // Combine all events - ensure dates are ISO strings for consistent frontend parsing
  const allEvents = [
    ...customEvents.map(e => ({
      ...e,
      id: e._id?.toString(),
      _id: e._id,
      type: e.type || 'custom',
      is_custom: true,
      date: toISODate(e.date) || e.date || new Date(),
      description: e.description || '',
      source: 'custom',
      completed: !!e.completed
    })),
    ...policyEvents,
    ...trainingEvents.map(t => ({ ...t, date: toISODate(t.date) || t.date })),
    ...boardMemberEvents,
    ...fundingEvents,
    ...documentEvents
  ];

  // Sort by date
  allEvents.sort((a, b) => {
    const dateA = new Date(a.date || 0);
    const dateB = new Date(b.date || 0);
    return dateA - dateB;
  });

 

  res.json({
    success: true,
    data: allEvents
  });
});

/**
 * Create a custom calendar event
 */
export const createCustomEvent = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const orgId = req.orgId;
  const { title, date, type, description, color, attendees } = req.body;

  // Validate required fields
  if (!title || !date) {
    throw new AppError('Title and date are required', 400, 'VALIDATION_ERROR');
  }

  const tenantDb = await getTenantConnection(orgId);
  const calendarRepo = new CalendarRepository(tenantDb);

  const attendeeIds = Array.isArray(attendees) ? attendees.filter(Boolean) : [];
  const normalizedAttendees = [...new Set(attendeeIds.map((id) => id.toString()))];
  if (!normalizedAttendees.includes(userId.toString())) {
    normalizedAttendees.push(userId.toString());
  }

  const eventData = {
    user_id: userId,
    title,
    date,
    type: type || 'custom',
    description,
    color,
    attendees: normalizedAttendees,
    is_custom: true,
    created_by: userId
  };

  const event = await calendarRepo.create(eventData);

  logInfo('Custom event created', { eventId: event._id, userId, orgId });

  res.status(201).json({
    success: true,
    data: event,
    message: 'Event created successfully'
  });
});

/**
 * Update a custom calendar event
 */
export const updateCustomEvent = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const orgId = req.orgId;
  const { id } = req.params;
  const { title, date, type, description, color, completed } = req.body;

  const tenantDb = await getTenantConnection(orgId);
  const calendarRepo = new CalendarRepository(tenantDb);

  // Check if event exists and belongs to user
  const existingEvent = await calendarRepo.findById(id);
  if (!existingEvent) {
    throw new AppError('Event not found', 404, 'NOT_FOUND');
  }

  if (!existingEvent.is_custom) {
    throw new AppError('Cannot edit system-generated events', 403, 'FORBIDDEN');
  }

  if (existingEvent.user_id.toString() !== userId) {
    throw new AppError('You do not have permission to edit this event', 403, 'FORBIDDEN');
  }

  const updateData = { updated_by: userId };
  if (title !== undefined) updateData.title = title;
  if (date !== undefined) updateData.date = date;
  if (type !== undefined) updateData.type = type;
  if (description !== undefined) updateData.description = description;
  if (color !== undefined) updateData.color = color;
  if (typeof completed === 'boolean') updateData.completed = completed;

  const updatedEvent = await calendarRepo.update(id, updateData);

  logInfo('Custom event updated', { eventId: id, userId, orgId });

  res.json({
    success: true,
    data: updatedEvent,
    message: 'Event updated successfully'
  });
});

/**
 * Delete a custom calendar event
 */
export const deleteCustomEvent = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const orgId = req.orgId;
  const { id } = req.params;

  const tenantDb = await getTenantConnection(orgId);
  const calendarRepo = new CalendarRepository(tenantDb);

  // Check if event exists and belongs to user
  const existingEvent = await calendarRepo.findById(id);
  if (!existingEvent) {
    throw new AppError('Event not found', 404, 'NOT_FOUND');
  }

  if (!existingEvent.is_custom) {
    throw new AppError('Cannot delete system-generated events', 403, 'FORBIDDEN');
  }

  if (existingEvent.user_id.toString() !== userId) {
    throw new AppError('You do not have permission to delete this event', 403, 'FORBIDDEN');
  }

  await calendarRepo.delete(id);

  logInfo('Custom event deleted', { eventId: id, userId, orgId });

  res.json({
    success: true,
    message: 'Event deleted successfully'
  });
});
