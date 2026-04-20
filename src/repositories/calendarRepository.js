/**
 * Calendar Repository
 * Data access layer for calendar events
 */

import mongoose from 'mongoose';
import calendarEventSchema from '../db/schemas/platform/calendarEventSchema.js';
import policySchema from '../db/schemas/platform/policySchema.js';
import trainingProgramSchema from '../db/schemas/platform/trainingProgramSchema.js';
import trainingEnrollmentSchema from '../db/schemas/platform/trainingEnrollmentSchema.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';
import activitySchema from '../db/schemas/platform/activitySchema.js';
import documentSchema from '../db/schemas/platform/documentSchema.js';
import meetingSchema from '../db/schemas/platform/meetingSchema.js';
import legalDocumentSchema from '../db/schemas/platform/legalDocumentSchema.js';

export class CalendarRepository {
  constructor(tenantDb) {
    // Ensure models are registered - use model() which registers if not exists
    this.CalendarEvent = tenantDb.models.CalendarEvent || 
      tenantDb.model('CalendarEvent', calendarEventSchema);
    this.Policy = tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
    this.TrainingProgram = tenantDb.models.TrainingProgram || tenantDb.model('TrainingProgram', trainingProgramSchema);
    this.TrainingEnrollment = tenantDb.models.TrainingEnrollment || tenantDb.model('TrainingEnrollment', trainingEnrollmentSchema);
    this.BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
    this.FundingAgreement = tenantDb.models.FundingAgreement || tenantDb.model('FundingAgreement', fundingAgreementSchema);
    this.Activity = tenantDb.models.Activity || tenantDb.model('Activity', activitySchema);
    this.Document = tenantDb.models.Document || tenantDb.model('Document', documentSchema);
    this.Meeting = tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);
    this.LegalDocument = tenantDb.models.LegalDocument || tenantDb.model('LegalDocument', legalDocumentSchema);
    this.itRegisterCollection = tenantDb.collection('it_register');
    this.legacyPhysicalLocationsCollection = tenantDb.collection('physical_storage_locations');
  }

  /**
   * Find calendar events by user ID
   */
  async findByUserId(userId, options = {}) {
    const query = {
      is_custom: true,
      $or: [
        { user_id: userId },
        { attendees: userId }
      ]
    };

    // Filter by date range if provided
    if (options.start_date || options.end_date) {
      query.date = {};
      if (options.start_date) {
        query.date.$gte = new Date(options.start_date);
      }
      if (options.end_date) {
        query.date.$lte = new Date(options.end_date);
      }
    }

    return await this.CalendarEvent.find(query)
      .sort({ date: 1 })
      .lean();
  }

  /**
   * Upsert a system-generated reminder event.
   * Uses (user_id, source_id, date, title) as a natural key.
   */
  async upsertSystemReminderEvent({ user_id, source_id, date, title, description, type = 'compliance', source = 'compliance' }) {
    const d = date instanceof Date ? date : new Date(date);
    return await this.CalendarEvent.findOneAndUpdate(
      { user_id, source_id, date: d, title },
      {
        $setOnInsert: {
          user_id,
          source_id,
          date: d,
          title,
          description: description || '',
          type,
          is_custom: true,
          source,
          created_at: new Date(),
          updated_at: new Date()
        },
        $set: { updated_at: new Date() }
      },
      { upsert: true, new: true }
    ).lean();
  }

  /**
   * Find policies with upcoming review dates
   */
  async findUpcomingPolicyReviews(orgId, options = {}) {
    // Convert orgId to ObjectId if it's a string (Mongoose will auto-convert, but explicit is safer)
    let orgIdObj = orgId;
    try {
      if (typeof orgId === 'string' && mongoose.Types.ObjectId.isValid(orgId)) {
        orgIdObj = new mongoose.Types.ObjectId(orgId);
      }
    } catch (e) {
      // Use original if conversion fails
    }
    const query = {
      org_id: orgIdObj,
      status: 'active',
      review_date: { $exists: true, $ne: null }
    };

    // Filter by date range if provided
    if (options.start_date || options.end_date) {
      const dateQuery = {};
      if (options.start_date) {
        dateQuery.$gte = new Date(options.start_date);
      }
      if (options.end_date) {
        dateQuery.$lte = new Date(options.end_date);
      }
      if (Object.keys(dateQuery).length > 0) {
        query.review_date = { $exists: true, $ne: null, ...dateQuery };
      }
    }

    return await this.Policy.find(query)
      .select('_id title review_date uploaded_by department')
      .sort({ review_date: 1 })
      .lean();
  }

  /**
   * Find training programs with upcoming renewals for a user
   */
  async findUpcomingTrainingRenewals(boardMemberId, options = {}) {
    // Find enrollments for this board member
    const enrollments = await this.TrainingEnrollment.find({
      board_member_id: boardMemberId,
      status: 'completed'
    })
      .select('training_program_id completed_at')
      .populate({
        path: 'training_program_id',
        select: 'title renewal_months expires'
      })
      .lean();

    // Calculate renewal dates: completed_at + renewal_months (when renewal_months is set)
    const renewalEvents = enrollments
      .filter(e => e.training_program_id && e.completed_at && (e.training_program_id.renewal_months || e.training_program_id.expires))
      .map(e => {
        const renewalMonths = e.training_program_id.renewal_months || 12;
        const renewalDate = new Date(e.completed_at);
        renewalDate.setMonth(renewalDate.getMonth() + renewalMonths);

        return {
          _id: e._id,
          title: `${e.training_program_id.title} - Renewal Due`,
          date: renewalDate,
          type: 'training'
        };
      });

    // Filter by date range if provided
    if (options.start_date || options.end_date) {
      return renewalEvents.filter(e => {
        if (options.start_date && e.date < new Date(options.start_date)) return false;
        if (options.end_date && e.date > new Date(options.end_date)) return false;
        return true;
      });
    }

    return renewalEvents;
  }

  /**
   * Find training program renewal events: published_at (or createdAt) + renewal_months per program
   * So a program created/published 13 Feb with renewal_months: 1 shows an event on 13 March
   */
  async findTrainingProgramRenewalEvents(orgId, options = {}) {
    let orgIdObj = orgId;
    try {
      if (typeof orgId === 'string' && mongoose.Types.ObjectId.isValid(orgId)) {
        orgIdObj = new mongoose.Types.ObjectId(orgId);
      }
    } catch (e) {
      // Use original if conversion fails
    }
    const programs = await this.TrainingProgram.find({
      org_id: orgIdObj,
      status: 'published',
      renewal_months: { $exists: true, $gt: 0 }
    })
      .select('_id title published_at createdAt renewal_months')
      .lean();

    const events = programs.map((p) => {
      const baseDate = p.published_at || p.createdAt;
      if (!baseDate) return null;
      const renewalDate = new Date(baseDate);
      renewalDate.setMonth(renewalDate.getMonth() + (p.renewal_months || 12));
      return {
        _id: `tp-${p._id.toString()}`,
        id: `tp-${p._id.toString()}`,
        title: `${p.title} - Renewal Due`,
        date: renewalDate,
        type: 'training',
        is_custom: false,
        source: 'training'
      };
    }).filter(Boolean);

    if (options.start_date || options.end_date) {
      return events.filter((e) => {
        if (options.start_date && e.date < new Date(options.start_date)) return false;
        if (options.end_date && e.date > new Date(options.end_date)) return false;
        return true;
      });
    }
    return events;
  }

  /**
   * Find board members with upcoming term end dates
   */
  async findUpcomingBoardMemberTermEnds(orgId, options = {}) {
    let orgIdObj = orgId;
    try {
      if (typeof orgId === 'string' && mongoose.Types.ObjectId.isValid(orgId)) {
        orgIdObj = new mongoose.Types.ObjectId(orgId);
      }
    } catch (e) {
      // Use original if conversion fails
    }
    const query = {
      org_id: orgIdObj,
      term_end_date: { $exists: true, $ne: null }
    };

    // Filter by date range if provided
    if (options.start_date || options.end_date) {
      const dateQuery = {};
      if (options.start_date) {
        dateQuery.$gte = new Date(options.start_date);
      }
      if (options.end_date) {
        dateQuery.$lte = new Date(options.end_date);
      }
      if (Object.keys(dateQuery).length > 0) {
        query.term_end_date = { $exists: true, $ne: null, ...dateQuery };
      }
    }

    return await this.BoardMember.find(query)
      .select('_id given_names family_name position term_end_date')
      .sort({ term_end_date: 1 })
      .lean();
  }

  /**
   * Find governing document and registration/license expiries
   */
  async findUpcomingDocumentExpiries(orgId, options = {}) {
    let orgIdObj = orgId;
    try {
      if (typeof orgId === 'string' && mongoose.Types.ObjectId.isValid(orgId)) {
        orgIdObj = new mongoose.Types.ObjectId(orgId);
      }
    } catch (e) {
      // Use original if conversion fails
    }

    const query = {
      org_id: orgIdObj,
      status: { $in: ['submitted', 'approved'] },
      expiry_date: { $exists: true, $ne: null },
      category: { $in: ['governing_document', 'constitution', 'trust_deed', 'certificate_of_incorporation', 'registration_license'] }
    };

    if (options.start_date || options.end_date) {
      const dateQuery = {};
      if (options.start_date) {
        dateQuery.$gte = new Date(options.start_date);
      }
      if (options.end_date) {
        dateQuery.$lte = new Date(options.end_date);
      }
      if (Object.keys(dateQuery).length > 0) {
        query.expiry_date = { $exists: true, $ne: null, ...dateQuery };
      }
    }

    return await this.Document.find(query)
      .select('_id title document_type category expiry_date')
      .sort({ expiry_date: 1 })
      .lean();
  }

  /**
   * Find governing document review dates.
   * Uses review_date when available, with effective_date/date_adopted as fallback.
   */
  async findUpcomingGoverningDocumentReviews(orgId, options = {}) {
    let orgIdObj = orgId;
    try {
      if (typeof orgId === 'string' && mongoose.Types.ObjectId.isValid(orgId)) {
        orgIdObj = new mongoose.Types.ObjectId(orgId);
      }
    } catch (e) {
      // Use original if conversion fails
    }

    const query = {
      org_id: orgIdObj,
      status: { $in: ['submitted', 'approved'] },
      $or: [
        { review_date: { $exists: true, $ne: null } },
        { effective_date: { $exists: true, $ne: null } },
        { date_adopted: { $exists: true, $ne: null } }
      ],
      category: { $in: ['governing_document', 'constitution', 'trust_deed', 'certificate_of_incorporation'] }
    };

    const docs = await this.Document.find(query)
      .select('_id title document_type category review_date effective_date date_adopted last_reviewed')
      .sort({ review_date: 1, effective_date: 1, date_adopted: 1 })
      .lean();

    if (!options.start_date && !options.end_date) return docs;

    const startDate = options.start_date ? new Date(options.start_date) : null;
    const endDate = options.end_date ? new Date(options.end_date) : null;
    return docs.filter((d) => {
      const due = d.review_date || d.effective_date || d.date_adopted;
      if (!due) return false;
      const dueDate = new Date(due);
      const lastReviewed = d.last_reviewed ? new Date(d.last_reviewed) : null;
      if (lastReviewed && lastReviewed >= dueDate) return false;
      if (startDate && dueDate < startDate) return false;
      if (endDate && dueDate > endDate) return false;
      return true;
    });
  }

  /**
   * Find legal document review dates.
   * Uses review_date when available, with effective_date as fallback for legacy records.
   */
  async findUpcomingLegalDocumentReviews(orgId, options = {}) {
    const query = {
      org_id: orgId,
      status: { $in: ['active'] },
      $or: [
        { review_date: { $exists: true, $ne: null } },
        { effective_date: { $exists: true, $ne: null } }
      ]
    };

    const docs = await this.LegalDocument.find(query)
      .select('_id document_name category review_date effective_date last_reviewed')
      .sort({ review_date: 1, effective_date: 1 })
      .lean();

    if (!options.start_date && !options.end_date) return docs;

    const startDate = options.start_date ? new Date(options.start_date) : null;
    const endDate = options.end_date ? new Date(options.end_date) : null;
    return docs.filter((d) => {
      const due = d.review_date || d.effective_date;
      if (!due) return false;
      const dueDate = new Date(due);
      const lastReviewed = d.last_reviewed ? new Date(d.last_reviewed) : null;
      if (lastReviewed && lastReviewed >= dueDate) return false;
      if (startDate && dueDate < startDate) return false;
      if (endDate && dueDate > endDate) return false;
      return true;
    });
  }

  /**
   * Find funding agreements with upcoming end dates (approved or pending)
   */
  async findUpcomingFundingAgreementEnds(orgId, options = {}) {
    let orgIdObj = orgId;
    try {
      if (typeof orgId === 'string' && mongoose.Types.ObjectId.isValid(orgId)) {
        orgIdObj = new mongoose.Types.ObjectId(orgId);
      }
    } catch (e) {
      // Use original if conversion fails
    }
    const query = {
      org_id: orgIdObj,
      end_date: { $exists: true, $ne: null },
      status: { $in: ['approved', 'pending'] }
    };

    // Filter by date range if provided
    if (options.start_date || options.end_date) {
      const dateQuery = {};
      if (options.start_date) {
        dateQuery.$gte = new Date(options.start_date);
      }
      if (options.end_date) {
        dateQuery.$lte = new Date(options.end_date);
      }
      if (Object.keys(dateQuery).length > 0) {
        query.end_date = { $exists: true, $ne: null, ...dateQuery };
      }
    }

    return await this.FundingAgreement.find(query)
      .select('_id agreement_title partner_name end_date')
      .sort({ end_date: 1 })
      .lean();
  }

  /**
   * Find meetings for calendar display
   */
  async findMeetings(orgId, options = {}) {
    const query = {
      org_id: orgId,
      status: { $nin: ['cancelled'] }
    };

    if (options.start_date || options.end_date) {
      query.date = {};
      if (options.start_date) {
        query.date.$gte = new Date(options.start_date);
      }
      if (options.end_date) {
        query.date.$lte = new Date(options.end_date);
      }
    }

    return await this.Meeting.find(query)
      .select('_id title date duration_minutes location meeting_link meeting_type status attendees')
      .sort({ date: 1 })
      .lean();
  }

  async findPhysicalRecordReviewEvents(orgId, options = {}) {
    const dateQuery = {};
    if (options.start_date) dateQuery.$gte = new Date(options.start_date);
    if (options.end_date) dateQuery.$lte = new Date(options.end_date);
    const itRegister = await this.itRegisterCollection.findOne({ org_id: orgId });
    let rows = Array.isArray(itRegister?.physical_locations) ? itRegister.physical_locations : [];
    if (!rows.length) {
      rows = await this.legacyPhysicalLocationsCollection.find({ org_id: orgId }).toArray();
    }
    const events = [];
    for (const row of rows) {
      const nextAudit = row.nextAuditDue || row.next_audit_due || null;
      const lastAudit = row.lastAuditDate || row.last_audit_date || null;
      const retentionEnd = row.retentionEndDate || row.retention_end_date || null;
      if (nextAudit || lastAudit) {
        const dueDate = nextAudit || (() => {
          const d = new Date(lastAudit);
          if (Number.isNaN(d.getTime())) return null;
          return new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
        })();
        if (dueDate) {
          events.push({
            _id: row._id,
            title: `${row.name || row.location_name || 'Record Location'} - Audit Review Due`,
            date: dueDate,
            description: 'Physical record keeping audit review',
            event_type: 'audit_due'
          });
        }
      }
      if (retentionEnd) {
        events.push({
          _id: row._id,
          title: `${row.name || row.location_name || 'Record Location'} - Retention End`,
          date: retentionEnd,
          description: 'Record retention period is approaching end',
          event_type: 'retention_end'
        });
      }
    }
    if (!Object.keys(dateQuery).length) return events;
    return events.filter((e) => {
      const d = new Date(e.date);
      if (Number.isNaN(d.getTime())) return false;
      if (dateQuery.$gte && d < dateQuery.$gte) return false;
      if (dateQuery.$lte && d > dateQuery.$lte) return false;
      return true;
    });
  }

  /**
   * Find event by ID
   */
  async findById(id) {
    return await this.CalendarEvent.findById(id).lean();
  }

  /**
   * Create a new calendar event
   */
  async create(eventData) {
    const event = new this.CalendarEvent(eventData);
    return await event.save();
  }

  /**
   * Update a calendar event
   */
  async update(id, updateData) {
    return await this.CalendarEvent.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true }
    ).lean();
  }

  /**
   * Delete a calendar event
   */
  async delete(id) {
    return await this.CalendarEvent.deleteOne({ _id: id });
  }
}
