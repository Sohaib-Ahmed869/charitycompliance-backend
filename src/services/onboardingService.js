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
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';

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
      //logInfo('Organization not found in tenant DB, creating placeholder for onboarding.', { orgId: this.orgId });
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

  async getDepartments() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    
   
    if (!org) {
      return [];
    }
    
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Debug: Get ALL departments for this specific org_id (including inactive)
    const allDepartmentsInDb = await departmentRepo.findAllByOrgId(org._id);
  
    // Now get only active departments
    const departments = await departmentRepo.findByOrgId(org._id);
    
    // If we have inactive departments but no active ones, something is wrong
    if (allDepartmentsInDb.length > 0 && departments.length === 0) {
      logError('getDepartments - WARNING: Found departments but all are inactive!', null, {
        orgId: org._id?.toString(),
        totalCount: allDepartmentsInDb.length,
        inactiveCount: allDepartmentsInDb.filter(d => !d.is_active).length
      });
    }
    
  
    
    return departments.map(dept => ({
      id: dept._id.toString(),
      name: dept.name,
      code: dept.code || '',
      description: dept.description || ''
    }));
  }

  async deleteDepartment(departmentId) {
    const tenantDb = await this.getTenantDb();
    const { DepartmentRepository } = await import('../repositories/departmentRepository.js');
    const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) {
      throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    const departmentRepo = new DepartmentRepository(tenantDb);
    const department = await departmentRepo.findById(departmentId);
    if (!department) {
      throw new AppError('Department not found', 404, 'DEPARTMENT_NOT_FOUND');
    }
    if (department.org_id.toString() !== org._id.toString()) {
      throw new AppError('Department does not belong to this organization', 403, 'FORBIDDEN');
    }
    await departmentRepo.delete(departmentId);
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

  // Step 1: Organization Details (name, organizationType, size, turnover)
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
      // Store all onboarding data in metadata for later use
      metadata: {
        size: stepData.size,
        organizationType: stepData.organizationType,
        turnover: stepData.turnover
      }
    });
    
    return { success: true };
  }

  // Step 2: Departments (handles both pre-defined and custom departments)
  async handleStep2(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const departmentRepo = new DepartmentRepository(tenantDb);
    
   
    // Simply create all departments that are sent - generate unique codes to avoid conflicts
    const departments = [];
    const updated = [];
    const errors = [];
    
    // Get existing departments to check for code conflicts
    const existingDepts = await departmentRepo.findAllByOrgId(orgId);
    const existingCodes = new Set(existingDepts.map(d => d.code?.toUpperCase()).filter(Boolean));
    
    // Generate unique code from department name if no code provided
    const generateCode = (name, existingCodes) => {
      // Try to create a code from the name (first 3-4 letters, uppercase)
      const baseCode = name
        .replace(/[^a-zA-Z0-9]/g, '') // Remove special characters
        .substring(0, 4)
        .toUpperCase();
      
      let code = baseCode;
      let counter = 1;
      
      // If code already exists, append a number
      while (existingCodes.has(code)) {
        code = `${baseCode}${counter}`;
        counter++;
      }
      
      existingCodes.add(code);
      return code;
    };
    
    for (const dept of stepData.departments || []) {
      try {
        // Build department data
        const departmentData = {
          org_id: orgId,
          name: dept.name,
          description: dept.description || undefined,
          is_active: true
        };
        
        // Generate or use provided code to avoid sparse index conflicts
        if (dept.code && dept.code.trim()) {
          departmentData.code = dept.code.trim().toUpperCase();
        } else {
          // Generate a unique code to avoid duplicate key errors on org_id + code
          departmentData.code = generateCode(dept.name, existingCodes);
        }
        
      
        
        const department = await departmentRepo.create(departmentData);
        
        departments.push(department);
       
      } catch (error) {
        // Handle duplicate key errors - find and update existing department
        if (error.code === 11000) {
         
          
          // Find existing department by name
          const foundDept = existingDepts.find(d => 
            d.org_id?.toString() === orgId?.toString() &&
            d.name.toLowerCase() === dept.name.toLowerCase()
          );
          
          if (foundDept) {
            // Update existing department with new data
            const updateData = {
              description: dept.description || foundDept.description,
              is_active: true
            };
            
            // Generate or use provided code
            if (dept.code && dept.code.trim()) {
              updateData.code = dept.code.trim().toUpperCase();
            } else if (!foundDept.code) {
              // If existing dept has no code, generate one to avoid future conflicts
              updateData.code = generateCode(dept.name, existingCodes);
            }
            
            const updatedDept = await departmentRepo.update(foundDept._id, updateData);
            departments.push(updatedDept);
            updated.push(dept.name);
           
          } else {
            // Department not found by name - might be a code conflict, try with generated code
            try {
              const retryData = {
                org_id: orgId,
                name: dept.name,
                description: dept.description || undefined,
                is_active: true,
                code: generateCode(dept.name, existingCodes)
              };
              
              const retryDept = await departmentRepo.create(retryData);
              departments.push(retryDept);
              Info('handleStep2 - created department with generated code on retry', {
                name: dept.name,
                code: retryDept.code
              });
            } catch (retryError) {
            
              errors.push({ name: dept.name, error: retryError.message });
            }
          }
        } else {
         
          errors.push({ name: dept.name, error: error.message });
        }
      }
    }
    
    
    
    return { 
      success: true, 
      data: { 
        count: departments.length,
        updated: updated.length,
        errors: errors.length > 0 ? errors : undefined
      } 
    };
  }

  // Step 3: Posilogtions (with permissions - link to departments created in step 2)
  async handleStep3(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const positionRepo = new PositionRepository(tenantDb);
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Get all departments created in step 2
    const allDepartments = await departmentRepo.findByOrgId(orgId);
    
    // Create positions and link to departments
    const positions = [];
    const skipped = [];
    const reactivated = [];
    
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
      
      // Build position data - only include code if it has a value
      // This prevents duplicate key errors with the sparse unique index on org_id + code
      const positionData = {
        org_id: orgId,
        title: pos.name, // Frontend sends 'name', backend expects 'title'
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
      };
      
      // Only include code if it has a non-empty value to avoid sparse index conflicts
      if (pos.code && pos.code.trim()) {
        positionData.code = pos.code.trim().toUpperCase();
      }
      
      try {
        const position = await positionRepo.create(positionData);
        positions.push(position);
       
      } catch (error) {
        // Handle duplicate key errors (for org_id + code unique index)
        if (error.code === 11000) {
         
          // Try to find existing position by title and department
          const existingPositions = await positionRepo.findByOrgId(orgId);
          const foundPos = existingPositions.find(p => 
            p.title === pos.name &&
            (departmentId ? p.department_id?.toString() === departmentId.toString() : !p.department_id)
          );
          
          if (foundPos) {
            // Reactivate if inactive
            if (!foundPos.is_active) {
              await positionRepo.update(foundPos._id, { is_active: true });
              reactivated.push(pos.name);
             
            } else {
              skipped.push(pos.name);
              logInfo('handleStep3 - skipped existing active position', {
                title: pos.name,
                positionId: foundPos._id?.toString()
              });
            }
          } else {
            // Position not found - this shouldn't happen with duplicate key error
            logWarn('handleStep3 - duplicate key but position not found', {
              positionName: pos.name,
              departmentId: departmentId?.toString()
            });
            skipped.push(pos.name);
          }
        } else {
          // Other errors - log and skip
          logError('handleStep3 - Error creating position', error, {
            positionName: pos.name,
            errorCode: error.code,
            errorMessage: error.message
          });
          skipped.push(pos.name);
        }
      }
    }
    
    return { 
      success: true, 
      data: { 
        count: positions.length,
        skipped: skipped.length,
        reactivated: reactivated.length
      } 
    };
  }

  // Step 4: Approval Matrix
  async handleStep4(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const approvalMatrixRepo = new ApprovalMatrixRepository(tenantDb);
    const positionRepo = new PositionRepository(tenantDb);
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Map frontend action types to backend enum values.
    // NOTE: We now store UI tags directly (risk/expense/grant/...) so workflows apply correctly.
    // Legacy values are still supported for older data.
    const actionTypeMap = {
      'risk': 'risk',
      'risks': 'risk',
      'risk_management': 'risk',
      'risk_approval': 'risk',
      'expense': 'expense',
      'expenses': 'expense',
      'grant': 'grant',
      'grants': 'grant',
      'grant_approval': 'grant',
      'contract': 'contract',
      'contracts': 'contract',
      'leave': 'leave',
      'hr': 'hr',
      'policy': 'policy',
      'policies': 'policy',
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

    // Create ONE ApprovalMatrix document per rule/workflow instead of packing all
    // rules into a single "Default Approval Matrix".
    const friendlyNames = {
      expense: 'Expense approvals',
      grant: 'Grant approvals',
      risk: 'Risk approvals',
      hr: 'HR approvals',
      policy: 'Policy approvals',
      contract: 'Contract approvals',
      other: 'Other approvals'
    };

    const createdMatrices = [];
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const typeKey = rule.action_type || 'other';
      const baseName = friendlyNames[typeKey] || 'Approval Matrix';
      const name = stepData.name
        ? `${stepData.name} - ${baseName}`
        : baseName;

      const matrixData = {
        org_id: orgId,
        name,
        description: stepData.description || '',
        rules: [rule],
        // First created matrix is marked as default; others are additional workflows.
        is_default: i === 0,
        is_active: true
      };

      const matrix = await approvalMatrixRepo.create(matrixData);
      createdMatrices.push(matrix._id);
    }

    return { success: true, matrices: createdMatrices };
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
