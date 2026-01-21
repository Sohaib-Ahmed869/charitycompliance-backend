/**
 * Onboarding Service
 * 
 * Business logic for initial 4-step onboarding flow
 * Steps: Organization Details, Departments, Positions, Approval Matrix
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { DepartmentRepository } from '../repositories/departmentRepository.js';
import { PositionRepository } from '../repositories/positionRepository.js';
import { logError, logInfo } from '../utils/logger.js';

export class OnboardingService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async getProgress() {
    const tenantDb = await this.getTenantDb();
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    
    // Get organization to use its _id
    const orgRepo = new OrganizationRepository(tenantDb);
    let org = await orgRepo.findOne();
    
    // If organization doesn't exist, create a basic one (shouldn't happen but handle gracefully)
    if (!org) {
      logInfo('Organization not found in tenant DB, creating placeholder for onboarding.', { orgId: this.orgId });
      org = await orgRepo.create({
        name: `Placeholder Org for ${this.orgId}`,
        orgId: this.orgId,
        status: 'pending_onboarding'
      });
    }
    
    let progress = await progressRepo.findByOrgId(org._id);
    
    if (!progress) {
      progress = await progressRepo.create(org._id);
    }
    
    return progress;
  }

  async updateStep(stepNumber, stepData = {}) {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    let org = await orgRepo.findOne();
    
    // If organization doesn't exist, create a basic one
    if (!org) {
      org = await orgRepo.create({
        name: stepData.name || 'New Organization',
        orgId: this.orgId,
        status: 'pending_setup'
      });
    }
    
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    
    // Handle step-specific data
    let result;
    switch (stepNumber) {
      case 1:
        result = await this.handleStep1(org._id, stepData);
        break;
      case 2:
        result = await this.handleStep2(org._id, stepData);
        break;
      case 3:
        result = await this.handleStep3(org._id, stepData);
        break;
      case 4:
        result = await this.handleStep4(org._id, stepData);
        break;
      default:
        throw new Error(`Invalid step number: ${stepNumber}`);
    }
    
    // Update progress after handling step data
    await progressRepo.updateStep(org._id, stepNumber, true, true);
    
    return result;
  }

  // Step 1: Organization Details
  async handleStep1(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    
    await orgRepo.update({
      name: stepData.name,
      trading_name: stepData.tradingName,
      abn: stepData.abn,
      address_street: stepData.addressStreet,
      address_city: stepData.addressCity,
      address_state: stepData.addressState,
      address_postcode: stepData.addressPostcode,
      phone: stepData.phone,
      email: stepData.email,
      website: stepData.website,
      description: stepData.description,
      industry: stepData.industry,
      employee_count: stepData.employeeCount || 0
    });
    
    return { success: true };
  }

  // Step 2: Departments (before positions - positions will be linked in step 3)
  async handleStep2(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Check for existing departments to avoid duplicates
    const existingDepartments = await departmentRepo.findByOrgId(orgId);
    
    // Create departments without position assignments (will be linked in step 3)
    const departments = [];
    for (const dept of stepData.departments || []) {
      // Check for duplicate name
      const duplicateName = existingDepartments.find(d => 
        d.name.toLowerCase() === dept.name.toLowerCase()
      );
      if (duplicateName) {
        throw new Error(`A department with name "${dept.name}" already exists. Please use a different name.`);
      }
      
      // Check for duplicate code (if code is provided)
      if (dept.code) {
        const duplicateCode = existingDepartments.find(d => 
          d.code && d.code.toUpperCase() === dept.code.toUpperCase()
        );
        if (duplicateCode) {
          throw new Error(`A department with code "${dept.code}" already exists. Please use a different code.`);
        }
      }
      
      try {
        const department = await departmentRepo.create({
          org_id: orgId,
          name: dept.name,
          code: dept.code ? dept.code.toUpperCase() : undefined,
          description: dept.description,
          is_active: true
        });
        departments.push(department);
      } catch (error) {
        // Catch MongoDB duplicate key errors and provide better messages
        if (error.code === 11000) {
          if (error.keyPattern?.code) {
            throw new Error(`A department with code "${dept.code}" already exists. Please use a different code.`);
          } else if (error.keyPattern?.name) {
            throw new Error(`A department with name "${dept.name}" already exists. Please use a different name.`);
          }
        }
        throw error;
      }
    }
    
    return { success: true, data: { count: departments.length } };
  }

  // Step 3: Positions (link to departments created in step 2)
  async handleStep3(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const positionRepo = new PositionRepository(tenantDb);
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Get all departments created in step 2
    const allDepartments = await departmentRepo.findByOrgId(orgId);
    
    // Create positions and link to departments
    const positions = [];
    for (const pos of stepData.positions || []) {
      let departmentId = null;
      
      // If department code/name provided, find matching department
      if (pos.departmentCode || pos.departmentName) {
        const department = allDepartments.find(d => 
          d.code === pos.departmentCode || d.name === pos.departmentName
        );
        if (department) {
          departmentId = department._id;
        }
      }
      
      const position = await positionRepo.create({
        org_id: orgId,
        title: pos.title,
        code: pos.code,
        description: pos.description,
        level: pos.level || 1,
        is_management: pos.isManagement || false,
        can_approve_expenses: pos.canApproveExpenses || false,
        max_approval_amount: pos.maxApprovalAmount || 0,
        department_id: departmentId,
        is_active: true
      });
      
      positions.push(position);
    }
    
    return { success: true, data: { count: positions.length } };
  }

  // Step 4: Approval Matrix
  async handleStep4(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
    
    const matrixData = {
      org_id: orgId,
      name: stepData.name || 'Default Approval Matrix',
      description: stepData.description,
      rules: stepData.rules || [],
      is_default: true,
      is_active: true
    };
    
    await approvalMatrixRepo.create(matrixData);
    
    return { success: true };
  }
}
