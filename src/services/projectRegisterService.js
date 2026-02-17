/**
 * Project Register Service
 *
 * Business logic for project registration.
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ProjectRegisterRepository } from '../repositories/projectRegisterRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { logInfo } from '../utils/logger.js';

const createProjectCode = () => {
  const year = new Date().getFullYear();
  const suffix = Math.floor(100 + Math.random() * 900);
  return `PRJ-${year}-${suffix}`;
};

export class ProjectRegisterService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async _getOrgObjectId() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    return org._id;
  }

  async createProject(data) {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new ProjectRegisterRepository(tenantDb);

    const project = await repo.create({
      org_id: orgId,
      project_code: data.project_code || createProjectCode(),
      agreement_title: data.agreement_title || '',
      agreement_id: data.agreement_id || null,
      project_name: data.project_name,
      description: data.description || '',
      planned_start_date: data.planned_start_date || null,
      planned_end_date: data.planned_end_date || null,
      status: data.status || 'pending',
      phase: data.phase || '',
      warning: data.warning || '',
      metadata: data.metadata || {}
    });

    logInfo('Project created', { projectId: project._id });

    // Trigger approval workflow if configured
    try {
      const workflowService = new ApprovalWorkflowService(this.orgId);
      const submittedBy = data.submitted_by || data.created_by;
      await workflowService.createProjectApprovalRequest(project._id, submittedBy);
    } catch (err) {
      // If there's no approval workflow for projects, auto-approve
      const errCode = err?.code;
      const isNoWorkflow =
        err?.name === 'CastError' ||
        errCode === 'INVALID_ID' ||
        errCode === 'NO_APPROVAL_MATRIX' ||
        errCode === 'NO_MATCHING_RULE';

      if (!isNoWorkflow) {
        await repo.delete(project._id);
        throw err;
      }

      logInfo('No approval workflow for projects; auto-approving', {
        projectId: project._id,
        errCode: errCode || err?.name
      });

      await repo.update(project._id, {
        status: 'approved',
        approval_matrix_id: null,
        approval_request_id: null
      });
    }

    return await repo.findById(project._id);
  }

  async getProjects(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new ProjectRegisterRepository(tenantDb);
    return await repo.findByOrgId(orgId, filters);
  }

  async getProjectCounts() {
    const tenantDb = await this.getTenantDb();
    const orgId = await this._getOrgObjectId();
    const repo = new ProjectRegisterRepository(tenantDb);
    return await repo.getCountsByOrg(orgId);
  }

  async getProjectById(projectId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ProjectRegisterRepository(tenantDb);
    const project = await repo.findById(projectId);
    if (!project) {
      throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return project;
  }
}
