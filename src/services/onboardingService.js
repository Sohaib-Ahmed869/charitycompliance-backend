/**
 * Onboarding Service
 * 
 * Business logic for initial 4-step onboarding flow
 * Steps: Organization Details, Departments, Positions, Approval Matrix
 */

import mongoose from 'mongoose';
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
      case 5:
        // Step 5 is Review - no data processing needed, just mark as complete
        result = await this.handleStep5(org._id, stepData);
        break;
      default:
        throw new Error(`Invalid step number: ${stepNumber}`);
    }
    
    // Update progress after handling step data
    // For step 5, we don't update a specific step field, but we ensure initial onboarding is marked complete
    if (stepNumber !== 5) {
      await progressRepo.updateStep(org._id, stepNumber, true, true);
    } else {
      // For step 5, just ensure initial onboarding is complete
      await progressRepo.recalculateProgress(org._id);
    }
    
    return result;
  }

  // Step 1: Organization Details (Simplified: name, size, turnover)
  async handleStep1(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    
    // Map size to employee_count range
    const sizeMapping = {
      '1-10': 5,
      '11-50': 30,
      '51-200': 125,
      '201-500': 350,
      '500+': 500
    };
    
    await orgRepo.update({
      name: stepData.name,
      employee_count: sizeMapping[stepData.size] || 0,
      // Store size and turnover as metadata for later use
      metadata: {
        size: stepData.size,
        turnover: stepData.turnover
      }
    });
    
    return { success: true };
  }

  // Step 2: Departments (handles both pre-defined and custom departments)
  async handleStep2(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Check for existing departments to avoid duplicates
    const existingDepartments = await departmentRepo.findByOrgId(orgId);
    
    // Create departments from stepData.departments array
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

  // Step 3: Positions (with permissions - link to departments created in step 2)
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
      
      // Find matching department by name
      if (pos.department) {
        const department = allDepartments.find(d => 
          d.name === pos.department
        );
        if (department) {
          departmentId = department._id;
        }
      }
      
      const position = await positionRepo.create({
        org_id: orgId,
        title: pos.name, // Frontend sends 'name', backend expects 'title'
        code: pos.code || undefined,
        description: pos.description || undefined,
        level: pos.level || 1,
        is_management: false, // Can be determined from level if needed
        can_approve_expenses: pos.canApproveExpenses || false,
        can_approve_risks: pos.canApproveRisks || false,
        can_approve_grants: pos.canApproveGrants || false,
        can_approve_policies: pos.canApprovePolicies || false,
        can_approve_hr: pos.canApproveHR || false,
        max_approval_amount: 0, // Can be configured later
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
    const positionRepo = new PositionRepository(tenantDb);
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Map frontend action types to backend enum values
    const actionTypeMap = {
      'risk': 'other',
      'risks': 'other',
      'expense': 'expense',
      'expenses': 'expense',
      'grant': 'other',
      'grants': 'other',
      'policy': 'policy_approval',
      'policies': 'policy_approval',
      'hr': 'other',
      'purchase': 'purchase',
      'document_approval': 'document_approval',
      'budget_approval': 'budget_approval',
      'other': 'other'
    };
    
    // Get all positions and departments to resolve IDs
    const allPositions = await positionRepo.findByOrgId(orgId);
    const allDepartments = await departmentRepo.findByOrgId(orgId);
    
    // Transform frontend camelCase to backend snake_case and resolve IDs
    let rules = [];
    if (stepData.rules && Array.isArray(stepData.rules) && stepData.rules.length > 0) {
      rules = await Promise.all(stepData.rules.map(async (rule) => {
        const actionType = rule.actionType || rule.action_type || 'expense';
        const mappedActionType = actionTypeMap[actionType.toLowerCase()] || 'other';
        
        // Resolve requires_approval_from with actual ObjectIds
        const requiresApprovalFrom = await Promise.all((rule.requiresApprovalFrom || rule.requires_approval_from || []).map(async (approver) => {
          let positionId = null;
          let departmentId = null;
          
          // First, try to resolve by position_name and department_name (most reliable)
          if (approver.position_name && approver.department_name) {
            // Find department by name
            const dept = allDepartments.find(d => 
              d.name === approver.department_name || 
              d.name.toLowerCase() === approver.department_name.toLowerCase()
            );
            
            if (dept) {
              departmentId = dept._id;
              // Find position by title/name and department
              const position = allPositions.find(p => 
                (p.title === approver.position_name || p.title.toLowerCase() === approver.position_name.toLowerCase()) &&
                p.department_id && p.department_id.toString() === dept._id.toString()
              );
              if (position) {
                positionId = position._id;
              }
            }
          }
          
          // Fallback: If position_id is a string (department ID or name), find the actual position
          if (!positionId && approver.position_id && typeof approver.position_id === 'string') {
            // Try to find department by name or ID
            const dept = allDepartments.find(d => 
              d.name === approver.position_id || 
              d.name.toLowerCase() === approver.position_id.toLowerCase() ||
              d.code === approver.position_id.toUpperCase() ||
              d._id.toString() === approver.position_id
            );
            
            if (dept) {
              departmentId = dept._id;
              // Find first position in this department
              const position = allPositions.find(p => 
                p.department_id && p.department_id.toString() === dept._id.toString()
              );
              if (position) {
                positionId = position._id;
              }
            }
          } else if (!positionId && approver.position_id) {
            // It's already an ObjectId or can be converted
            try {
              if (typeof approver.position_id === 'string' && approver.position_id.length === 24) {
                positionId = new mongoose.Types.ObjectId(approver.position_id);
                // Find the position to get its department
                const position = allPositions.find(p => p._id.toString() === positionId.toString());
                if (position && position.department_id) {
                  departmentId = position.department_id;
                }
              } else {
                positionId = approver.position_id;
              }
            } catch (e) {
              // Invalid ObjectId, try to find by name
              const position = allPositions.find(p => 
                p.title === approver.position_id || 
                p.title.toLowerCase() === approver.position_id.toLowerCase() ||
                p.code === approver.position_id
              );
              if (position) {
                positionId = position._id;
                departmentId = position.department_id;
              }
            }
          }
          
          // If department_id is a string, resolve it
          if (!departmentId && approver.department_id && typeof approver.department_id === 'string') {
            const dept = allDepartments.find(d => 
              d.name === approver.department_id || 
              d.name.toLowerCase() === approver.department_id.toLowerCase() ||
              d.code === approver.department_id.toUpperCase() ||
              d._id.toString() === approver.department_id
            );
            if (dept) {
              departmentId = dept._id;
            }
          } else if (!departmentId && approver.department_id) {
            try {
              if (typeof approver.department_id === 'string' && approver.department_id.length === 24) {
                departmentId = new mongoose.Types.ObjectId(approver.department_id);
              } else {
                departmentId = approver.department_id;
              }
            } catch (e) {
              // Invalid ObjectId, ignore
            }
          }
          
          return {
            approval_level: approver.approval_level || approver.approvalLevel || 1,
            position_id: positionId,
            department_id: departmentId,
            user_id: approver.user_id || approver.userId || null
          };
        }));
        
        return {
          action_type: mappedActionType,
          min_amount: rule.minAmount !== undefined ? rule.minAmount : (rule.min_amount !== undefined ? rule.min_amount : 0),
          max_amount: rule.maxAmount !== undefined ? rule.maxAmount : rule.max_amount,
          approval_type: rule.approvalType || rule.approval_type || 'sequential',
          requires_approval_from: requiresApprovalFrom,
          is_active: rule.isActive !== undefined ? rule.isActive : (rule.is_active !== undefined ? rule.is_active : true)
        };
      }));
    } else {
      // If no rules provided, create a default rule for expenses
      rules = [{
        action_type: 'expense',
        min_amount: 0,
        max_amount: null, // Unlimited
        approval_type: 'sequential',
        requires_approval_from: [],
        is_active: true
      }];
    }
    
    const matrixData = {
      org_id: orgId,
      name: stepData.name || 'Default Approval Matrix',
      description: stepData.description || '',
      rules: rules,
      is_default: true,
      is_active: true
    };
    
    await approvalMatrixRepo.create(matrixData);
    
    return { success: true };
  }

  // Step 5: Review - Mark initial onboarding as complete
  async handleStep5(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    
    // Ensure all previous steps are marked complete and mark initial onboarding as complete
    const progress = await progressRepo.findByOrgId(orgId);
    if (progress) {
      // Update to mark initial onboarding as complete
      await progressRepo.OnboardingProgress.findOneAndUpdate(
        { org_id: orgId },
        { 
          $set: { 
            current_step: 5,
            initial_onboarding_complete: true,
            initial_onboarding_completed_at: new Date()
          }
        },
        { new: true }
      );
      
      // Recalculate progress to ensure percentages are correct
      await progressRepo.recalculateProgress(orgId);
    }
    
    return { success: true, message: 'Onboarding completed successfully' };
  }

  async updateProfileCompletionStep(stepKey, completed) {
    const tenantDb = await this.getTenantDb();
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    
    // Get organization
    const orgRepo = new OrganizationRepository(tenantDb);
    let org = await orgRepo.findOne();
    
    if (!org) {
      throw new Error('Organization not found');
    }
    
    // Update the specific step
    const progress = await progressRepo.updateProfileStep(org._id, stepKey, completed);
    
    return progress;
  }
}
