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

    const org = await orgRepo.findOne();
    const orgId = org?._id || this.orgId;

    // Check if user has permission to view complaints
    const hasComplaintAccess = this.hasModulePermission(userPermissions, 'complaints');
    const complaintUserId = hasComplaintAccess ? userId : null;

    const [risks, assets, tickets, legalDocs, complaints, policies, enhancedRisks, approvalTurnaround, income, expenses] = await Promise.allSettled([
      riskRepo.getCountsByOrg(this.orgId),
      assetRepo.getAssetStats(this.orgId),
      ticketRepo.getStats(this.orgId),
      legalDocRepo.getStats(this.orgId),
      hasComplaintAccess ? complaintRepo.getStats(orgId, complaintUserId) : Promise.resolve({}),
      policyRepo.getCounts(this.orgId),
      this._getEnhancedRiskStats(tenantDb),
      this._getApprovalTurnaround(approvalRepo),
      fundingAgreementRepo.getCountsByOrg(this.orgId),
      expenseRepo.getExpenseStats(this.orgId),
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

    return {
      risks: risks.status === 'fulfilled' ? risks.value : { total: 0, highExtreme: 0, underTreatment: 0, overdueReview: 0, bySeverity: {} },
      enhancedRisks: enhancedRisks.status === 'fulfilled' ? enhancedRisks.value : { treated: 0, closed: 0, mitigationRate: 0 },
      assets: assets.status === 'fulfilled' ? assets.value : { totalAssets: 0, activeAssets: 0, maintenanceAssets: 0, totalValue: 0 },
      supportTickets: tickets.status === 'fulfilled' ? tickets.value : { statusCounts: {}, priorityCounts: {}, totalCount: 0, satisfaction: {} },
      legalDocuments: legalDocs.status === 'fulfilled' ? legalDocs.value : { total: 0, active: 0, expired: 0, archived: 0, expiringSoon: 0 },
      complaints: normalizedComplaints,
      policies: policies.status === 'fulfilled' ? policies.value : { total: 0, draft: 0, active: 0, underReview: 0, expired: 0 },
      approvals: approvalTurnaround.status === 'fulfilled' ? approvalTurnaround.value : { avgTurnaroundDays: 0, completedCount: 0, thisMonthCount: 0 },
      income: income.status === 'fulfilled' ? income.value : { committed: 0, approved: 0, total: 0 },
      expenses: expenses.status === 'fulfilled' ? expenses.value : { paidAmount: 0, approvedAmount: 0, paidCount: 0, approvedCount: 0 },
    };
  }

  async _getEnhancedRiskStats(tenantDb) {
    const riskRepo = new RiskRepository(tenantDb);
    const Risk = riskRepo.Risk;

    const allRisks = await Risk.find({ org_id: this.orgId });
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

  async _getApprovalTurnaround(approvalRepo) {
    const ApprovalRequest = approvalRepo.ApprovalRequest;
    if (!ApprovalRequest) return { avgTurnaroundDays: 0, completedCount: 0, thisMonthCount: 0 };

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const completed = await ApprovalRequest.find({
      org_id: this.orgId,
      status: { $in: ['approved', 'rejected'] },
      completed_at: { $exists: true, $ne: null },
    }).select('created_at completed_at').lean();

    let totalDays = 0;
    let count = 0;
    for (const req of completed) {
      if (req.created_at && req.completed_at) {
        const days = (new Date(req.completed_at) - new Date(req.created_at)) / (1000 * 60 * 60 * 24);
        if (days >= 0) { totalDays += days; count++; }
      }
    }

    const thisMonthCount = await ApprovalRequest.countDocuments({
      org_id: this.orgId,
      status: { $in: ['approved', 'rejected'] },
      completed_at: { $gte: startOfMonth },
    });

    return {
      avgTurnaroundDays: count > 0 ? Math.round((totalDays / count) * 10) / 10 : 0,
      completedCount: count,
      thisMonthCount,
    };
  }
}
