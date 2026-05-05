import { getTenantConnection } from '../db/connectionManager.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { AssetRepository } from '../repositories/assetRepository.js';
import { SupportTicketRepository } from '../repositories/supportTicketRepository.js';
import { LegalDocumentRepository } from '../repositories/legalDocumentRepository.js';
import { ComplaintRepository } from '../repositories/complaintRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { PolicyRepository } from '../repositories/policyRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { FundingAgreementRepository } from '../repositories/fundingAgreementRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { CoiRequestRepository } from '../repositories/coiRequestRepository.js';
import { MeetingRepository } from '../repositories/meetingRepository.js';

export class DashboardService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  /**
   * Check if user has permission to view a module
   * @param {Array} userPermissions - User's permissions array
   * @param {string} moduleId - Module ID (e.g., 'complaints')
   * @returns {boolean} - Whether user has view permission
   */
  hasModulePermission(userPermissions, moduleId) {
    if (!Array.isArray(userPermissions)) return false;
    // Admin access or wildcard permission
    if (userPermissions.includes('*:*') || userPermissions.includes('admin')) return true;
    // Specific module permission
    return userPermissions.includes(`module:${moduleId}:view`) ||
           userPermissions.includes(`module:${moduleId}:manage`);
  }

  async getAggregatedStats(userId = null, userPermissions = []) {
    const tenantDb = await this.getTenantDb();

    const riskRepo = new RiskRepository(tenantDb);
    const assetRepo = new AssetRepository(tenantDb);
    const ticketRepo = new SupportTicketRepository(tenantDb);
    const legalDocRepo = new LegalDocumentRepository(tenantDb);
    const complaintRepo = new ComplaintRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    const policyRepo = new PolicyRepository(tenantDb);
    const approvalRepo = new ApprovalRequestRepository(tenantDb);
    const fundingAgreementRepo = new FundingAgreementRepository(tenantDb);
    const expenseRepo = new ExpenseRepository(tenantDb);
    const coiRepo = new CoiRequestRepository(tenantDb);
    const meetingRepo = new MeetingRepository(tenantDb);

    const org = await orgRepo.findOne();
    // org_id is stored as ObjectId in some collections (Risk, Policy, COI,
    // FundingAgreement, ApprovalRequest) and as the slug string in others
    // (Asset, Meeting, Expense, SupportTicket, LegalDocument). Pass the
    // matching shape per repo or queries silently return zero.
    const orgObjectId = org?._id || this.orgId;
    const orgSlug = this.orgId;

    // Check if user has permission to view complaints
    const hasComplaintAccess = this.hasModulePermission(userPermissions, 'complaints');
    const complaintUserId = hasComplaintAccess ? userId : null;

    const [
      risks,
      assets,
      tickets,
      legalDocs,
      complaints,
      policies,
      enhancedRisks,
      approvalTurnaround,
      approvalTrend,
      income,
      expenses,
      coiStats,
      meetingStats,
    ] = await Promise.allSettled([
      riskRepo.getCountsByOrg(orgObjectId),                                  // ObjectId
      assetRepo.getAssetStats(orgSlug),                                       // slug
      ticketRepo.getStats(orgSlug),                                           // slug
      legalDocRepo.getStats(orgSlug),                                         // slug
      hasComplaintAccess ? complaintRepo.getStats(orgObjectId, complaintUserId) : Promise.resolve({}),
      policyRepo.getCounts(orgObjectId),                                      // ObjectId
      this._getEnhancedRiskStats(tenantDb, orgObjectId),
      this._getApprovalTurnaround(approvalRepo, orgObjectId),
      this._getApprovalTrend(approvalRepo, orgObjectId),
      fundingAgreementRepo.getCountsByOrg(orgObjectId),                       // ObjectId
      expenseRepo.getExpenseStats(orgSlug),                                   // slug
      this._getCoiStats(coiRepo, orgObjectId),
      this._getMeetingStats(meetingRepo, orgSlug),
    ]);

    const rawComplaints = (complaints.status === 'fulfilled' && hasComplaintAccess) ? complaints.value : {};
    const normalizedComplaints = hasComplaintAccess ? {
      total: rawComplaints?.total?.[0]?.count || 0,
      byStatus: Array.isArray(rawComplaints?.byStatus)
        ? rawComplaints.byStatus.reduce((acc, c) => { if (c._id) acc[c._id] = c.count; return acc; }, {})
        : {},
      byCategory: Array.isArray(rawComplaints?.byCategory)
        ? rawComplaints.byCategory.reduce((acc, c) => { if (c._id) acc[c._id] = c.count; return acc; }, {})
        : {},
      byPriority: Array.isArray(rawComplaints?.byPriority)
        ? rawComplaints.byPriority.reduce((acc, c) => { if (c._id) acc[c._id] = c.count; return acc; }, {})
        : {},
      avgResolutionTime: rawComplaints?.avgResolutionTime?.[0]?.avgDays || 0,
    } : {
      total: 0,
      byStatus: {},
      byCategory: {},
      byPriority: {},
      avgResolutionTime: 0,
    };

    const turnaround = approvalTurnaround.status === 'fulfilled'
      ? approvalTurnaround.value
      : { avgTurnaroundDays: 0, completedCount: 0, thisMonthCount: 0 };
    const trend = approvalTrend.status === 'fulfilled' ? approvalTrend.value : [];

    return {
      risks: risks.status === 'fulfilled' ? risks.value : { total: 0, highExtreme: 0, underTreatment: 0, overdueReview: 0, bySeverity: {} },
      enhancedRisks: enhancedRisks.status === 'fulfilled' ? enhancedRisks.value : { treated: 0, closed: 0, mitigationRate: 0 },
      assets: assets.status === 'fulfilled' ? assets.value : { totalAssets: 0, activeAssets: 0, maintenanceAssets: 0, totalValue: 0 },
      supportTickets: tickets.status === 'fulfilled' ? tickets.value : { statusCounts: {}, priorityCounts: {}, totalCount: 0, satisfaction: {} },
      legalDocuments: legalDocs.status === 'fulfilled' ? legalDocs.value : { total: 0, active: 0, expired: 0, archived: 0, expiringSoon: 0 },
      complaints: normalizedComplaints,
      policies: policies.status === 'fulfilled' ? policies.value : { total: 0, draft: 0, active: 0, underReview: 0, expired: 0 },
      approvals: { ...turnaround, last6MonthsTrend: trend },
      income: income.status === 'fulfilled' ? income.value : { committed: 0, approved: 0, total: 0 },
      expenses: expenses.status === 'fulfilled' ? expenses.value : { paidAmount: 0, approvedAmount: 0, paidCount: 0, approvedCount: 0 },
      coi: coiStats.status === 'fulfilled' ? coiStats.value : { total: 0, pending: 0, approved: 0, rejected: 0, last90Days: 0, internal: 0, external: 0 },
      meetings: meetingStats.status === 'fulfilled' ? meetingStats.value : { upcoming: 0, completed: 0, cancelled: 0, lastHeldDate: null, nextMeetingDate: null, attendanceRate: 0, pendingRsvps: 0 },
    };
  }

  async _getEnhancedRiskStats(tenantDb, orgId) {
    const riskRepo = new RiskRepository(tenantDb);
    const Risk = riskRepo.Risk;

    const allRisks = await Risk.find({ org_id: orgId ?? this.orgId });
    const total = allRisks.length;
    const treated = allRisks.filter(r => ['resolved', 'closed', 'approved'].includes(r.status)).length;
    const closed = allRisks.filter(r => r.status === 'closed').length;

    let totalTreatments = 0;
    let implementedTreatments = 0;
    for (const risk of allRisks) {
      if (risk.treatments?.length) {
        totalTreatments += risk.treatments.length;
        implementedTreatments += risk.treatments.filter(t => ['implemented', 'resolved'].includes(t.status)).length;
      }
    }

    return {
      treated,
      closed,
      mitigationRate: total > 0 ? Math.round((treated / total) * 100) : 0,
      totalTreatments,
      implementedTreatments,
      treatmentRate: totalTreatments > 0 ? Math.round((implementedTreatments / totalTreatments) * 100) : 0,
    };
  }

  async _getApprovalTurnaround(approvalRepo, orgId) {
    const ApprovalRequest = approvalRepo.ApprovalRequest;
    if (!ApprovalRequest) return { avgTurnaroundDays: 0, completedCount: 0, thisMonthCount: 0 };

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Pull terminal-status requests; tolerate older records that never got
    // completed_at written by falling back to updatedAt or rejected/approved
    // step timestamps when computing turnaround.
    const completed = await ApprovalRequest.find({
      org_id: orgId ?? this.orgId,
      status: { $in: ['approved', 'rejected'] },
    }).select('created_at completed_at updatedAt approval_steps').lean();

    const resolveCompletion = (req) => {
      if (req.completed_at) return new Date(req.completed_at);
      // Try the latest approval-step timestamp (approved_at / rejected_at).
      let latestStep = null;
      for (const s of req.approval_steps || []) {
        const t = s?.approved_at || s?.rejected_at;
        if (!t) continue;
        const d = new Date(t);
        if (!latestStep || d > latestStep) latestStep = d;
      }
      if (latestStep) return latestStep;
      if (req.updatedAt) return new Date(req.updatedAt);
      return null;
    };

    let totalDays = 0;
    let count = 0;
    let thisMonthCount = 0;
    for (const req of completed) {
      const completedAt = resolveCompletion(req);
      if (!completedAt) continue;
      if (req.created_at) {
        const days = (completedAt - new Date(req.created_at)) / (1000 * 60 * 60 * 24);
        if (days >= 0) { totalDays += days; count++; }
      }
      if (completedAt >= startOfMonth) thisMonthCount++;
    }

    return {
      avgTurnaroundDays: count > 0 ? Math.round((totalDays / count) * 10) / 10 : 0,
      completedCount: count,
      thisMonthCount,
    };
  }

  /**
   * Real 6-month trend (oldest → newest). Each entry: { month: 'Jan',
   * year: 2026, count }. Counts approvals whose terminal completion (or
   * updatedAt fallback) falls inside the calendar month.
   */
  async _getApprovalTrend(approvalRepo, orgId) {
    const ApprovalRequest = approvalRepo.ApprovalRequest;
    if (!ApprovalRequest) return [];

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const docs = await ApprovalRequest.find({
      org_id: orgId ?? this.orgId,
      status: { $in: ['approved', 'rejected'] },
    }).select('completed_at updatedAt approval_steps status').lean();

    const buckets = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        month: d.toLocaleString('en-US', { month: 'short' }),
        year: d.getFullYear(),
        count: 0,
        approved: 0,
        rejected: 0,
      });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));

    const resolveCompletion = (req) => {
      if (req.completed_at) return new Date(req.completed_at);
      let latestStep = null;
      for (const s of req.approval_steps || []) {
        const t = s?.approved_at || s?.rejected_at;
        if (!t) continue;
        const d = new Date(t);
        if (!latestStep || d > latestStep) latestStep = d;
      }
      if (latestStep) return latestStep;
      if (req.updatedAt) return new Date(req.updatedAt);
      return null;
    };

    for (const req of docs) {
      const at = resolveCompletion(req);
      if (!at || at < monthStart) continue;
      const key = `${at.getFullYear()}-${at.getMonth()}`;
      const bucket = byKey.get(key);
      if (!bucket) continue;
      bucket.count += 1;
      if (req.status === 'approved') bucket.approved += 1;
      else if (req.status === 'rejected') bucket.rejected += 1;
    }

    return buckets.map(({ key, ...rest }) => rest); // drop internal key
  }

  async _getCoiStats(coiRepo, orgId) {
    const CoiRequest = coiRepo.CoiRequest;
    if (!CoiRequest) return { total: 0, pending: 0, approved: 0, rejected: 0, last90Days: 0, internal: 0, external: 0 };

    const now = new Date();
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const all = await CoiRequest.find({ org_id: orgId ?? this.orgId })
      .select('status created_at is_external submission_source')
      .lean();

    const total = all.length;
    let pending = 0, approved = 0, rejected = 0, last90Days = 0;
    let internal = 0, external = 0;

    for (const r of all) {
      if (r.status === 'pending') pending++;
      else if (r.status === 'approved') approved++;
      else if (r.status === 'rejected') rejected++;

      const created = r.created_at ? new Date(r.created_at) : null;
      if (created && created >= ninetyDaysAgo) last90Days++;

      if (r.is_external === true || r.submission_source === 'external') external++;
      else internal++;
    }

    return { total, pending, approved, rejected, last90Days, internal, external };
  }

  async _getMeetingStats(meetingRepo, orgId) {
    const Meeting = meetingRepo.Meeting;
    if (!Meeting) {
      return { upcoming: 0, completed: 0, cancelled: 0, lastHeldDate: null, nextMeetingDate: null, attendanceRate: 0, pendingRsvps: 0 };
    }

    const now = new Date();
    const meetings = await Meeting.find({ org_id: orgId ?? this.orgId })
      .select('status date attendees external_attendees')
      .lean();

    let upcoming = 0, completed = 0, cancelled = 0, pendingRsvps = 0;
    let lastHeldDate = null, nextMeetingDate = null;
    let attendeesTotal = 0, attendeesPresent = 0;

    for (const m of meetings) {
      if (m.status === 'cancelled') cancelled++;
      else if (m.status === 'completed') completed++;

      const d = m.date ? new Date(m.date) : null;
      if (d) {
        if (m.status === 'completed' && (!lastHeldDate || d > lastHeldDate)) lastHeldDate = d;
        if (m.status === 'scheduled' && d >= now) {
          upcoming++;
          if (!nextMeetingDate || d < nextMeetingDate) nextMeetingDate = d;
        }
      }

      // Pending RSVPs only meaningful on upcoming meetings
      if (m.status === 'scheduled' && d && d >= now) {
        for (const a of m.attendees || []) {
          if (a.attendance_status === 'invited') pendingRsvps++;
        }
        for (const a of m.external_attendees || []) {
          if (a.attendance_status === 'invited') pendingRsvps++;
        }
      }

      // Attendance rate: count attended / invited on completed meetings only
      if (m.status === 'completed') {
        for (const a of m.attendees || []) {
          attendeesTotal++;
          if (a.attendance_status === 'attended') attendeesPresent++;
        }
        for (const a of m.external_attendees || []) {
          attendeesTotal++;
          if (a.attendance_status === 'attended') attendeesPresent++;
        }
      }
    }

    return {
      upcoming,
      completed,
      cancelled,
      lastHeldDate: lastHeldDate ? lastHeldDate.toISOString() : null,
      nextMeetingDate: nextMeetingDate ? nextMeetingDate.toISOString() : null,
      attendanceRate: attendeesTotal > 0 ? Math.round((attendeesPresent / attendeesTotal) * 100) : 0,
      pendingRsvps,
    };
  }
}
