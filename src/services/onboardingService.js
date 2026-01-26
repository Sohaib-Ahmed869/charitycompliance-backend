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

  async getDepartments() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    
    logInfo('getDepartments - org lookup', { 
      orgId: this.orgId, 
      foundOrg: !!org, 
      orgDbId: org?._id?.toString(),
      orgName: org?.name
    });
    
    if (!org) {
      return [];
    }
    
    const departmentRepo = new DepartmentRepository(tenantDb);
    
    // Debug: Get ALL departments for this specific org_id (including inactive)
    const allDepartmentsInDb = await departmentRepo.findAllByOrgId(org._id);
    logInfo('getDepartments - ALL departments for this org_id (incl inactive)', {
      orgId: org._id?.toString(),
      count: allDepartmentsInDb.length,
      departments: allDepartmentsInDb.map(d => ({ 
        name: d.name, 
        orgId: d.org_id?.toString(), 
        isActive: d.is_active,
        _id: d._id?.toString()
      }))
    });
    
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
    
    logInfo('getDepartments - ACTIVE departments', { 
      orgId: org._id?.toString(),
      count: departments.length,
      names: departments.map(d => d.name)
    });
    
    return departments.map(dept => ({
      name: dept.name,
      code: dept.code || '',
      description: dept.description || ''
    }));
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
    
    logInfo('handleStep2 - starting', { 
      orgId: orgId?.toString(), 
      incomingDepartments: stepData.departments?.map(d => d.name) 
    });
    
    // Check for existing ACTIVE departments - verify org_id matches exactly
    const existingActiveDepartments = await departmentRepo.findByOrgId(orgId);
    // Double-check that all returned departments actually belong to this org
    const verifiedActiveDepartments = existingActiveDepartments.filter(d => 
      d.org_id?.toString() === orgId?.toString()
    );
    const existingActiveNames = new Set(verifiedActiveDepartments.map(d => d.name.toLowerCase()));
    const existingActiveCodes = new Set(verifiedActiveDepartments.map(d => d.code?.toUpperCase()).filter(Boolean));
    
    logInfo('handleStep2 - existing active departments', { 
      queryCount: existingActiveDepartments.length,
      verifiedCount: verifiedActiveDepartments.length,
      orgId: orgId?.toString(),
      names: Array.from(existingActiveNames),
      departments: verifiedActiveDepartments.map(d => ({
        name: d.name,
        orgId: d.org_id?.toString(),
        _id: d._id?.toString()
      }))
    });
    
    // Also check for ALL departments (including inactive) to reactivate them if needed
    const allDepartments = await departmentRepo.findAllByOrgId(orgId);
    // Double-check org_id matches - use strict comparison
    const orgIdString = orgId?.toString();
    const verifiedAllDepartments = allDepartments.filter(d => {
      const deptOrgIdString = d.org_id?.toString();
      const matches = deptOrgIdString === orgIdString;
      if (!matches) {
        logWarn('handleStep2 - Filtering out department with mismatched orgId', {
          deptName: d.name,
          deptOrgId: deptOrgIdString,
          expectedOrgId: orgIdString,
          deptId: d._id?.toString()
        });
      }
      return matches;
    });
    const allDepartmentsByName = new Map(verifiedAllDepartments.map(d => [d.name.toLowerCase(), d]));
    
    logInfo('handleStep2 - all departments (incl inactive)', { 
      queryCount: allDepartments.length,
      verifiedCount: verifiedAllDepartments.length,
      orgId: orgId?.toString(),
      names: verifiedAllDepartments.map(d => `${d.name} (active: ${d.is_active}, orgId: ${d.org_id?.toString()})`),
      mapKeys: Array.from(allDepartmentsByName.keys()),
      mapEntries: Array.from(allDepartmentsByName.entries()).map(([key, dept]) => ({
        key,
        name: dept.name,
        orgId: dept.org_id?.toString(),
        isActive: dept.is_active,
        _id: dept._id?.toString()
      }))
    });
    
    // Create departments from stepData.departments array
    // Skip departments that already exist instead of erroring
    const departments = [];
    let skipped = []; // Use let instead of const to allow correction if incorrectly marked as skipped
    const reactivated = [];
    
    logInfo('handleStep2 - processing requested departments', {
      requestedCount: stepData.departments?.length || 0,
      requestedNames: (stepData.departments || []).map(d => d.name),
      requestedNamesLower: (stepData.departments || []).map(d => d.name.toLowerCase()),
      orgId: orgId?.toString()
    });
    
    for (const dept of stepData.departments || []) {
      const deptNameLower = dept.name.toLowerCase();
      
      logInfo('handleStep2 - checking department', {
        name: dept.name,
        nameLower: deptNameLower,
        mapHasKey: allDepartmentsByName.has(deptNameLower),
        orgId: orgId?.toString()
      });
      
      // Check if department already exists (active or inactive)
      const existingDept = allDepartmentsByName.get(deptNameLower);
      
      if (existingDept) {
        // Verify the department belongs to the correct organization
        const deptOrgId = existingDept.org_id?.toString();
        const targetOrgId = orgId?.toString();
        
        // CRITICAL: Verify orgId matches exactly (using strict comparison)
        if (deptOrgId !== targetOrgId) {
          logError('handleStep2 - Department exists but with different org_id!', null, {
            deptName: dept.name,
            deptOrgId,
            targetOrgId,
            deptId: existingDept._id?.toString(),
            mapEntry: {
              name: existingDept.name,
              orgId: existingDept.org_id?.toString(),
              isActive: existingDept.is_active
            }
          });
          // Don't skip - create a new one with correct org_id
          // (fall through to create logic below)
        } else {
          // Department exists with correct org_id - ensure it's active
          if (!existingDept.is_active) {
            await departmentRepo.update(existingDept._id, { is_active: true });
            reactivated.push(dept.name);
            logInfo('handleStep2 - reactivated department', { 
              name: dept.name, 
              deptId: existingDept._id?.toString(),
              orgId: existingDept.org_id?.toString()
            });
          } else {
            skipped.push(dept.name);
            logInfo('handleStep2 - skipped existing active department', { 
              name: dept.name, 
              deptId: existingDept._id?.toString(),
              orgId: existingDept.org_id?.toString(),
              mapEntry: {
                name: existingDept.name,
                orgId: existingDept.org_id?.toString(),
                isActive: existingDept.is_active,
                _id: existingDept._id?.toString()
              }
            });
          }
          continue;
        }
      }
      
      // Check for duplicate code (if code is provided)
      const duplicateCode = dept.code && existingActiveCodes.has(dept.code.toUpperCase());
      if (duplicateCode) {
        skipped.push(dept.name);
        continue;
      }
      
      try {
        const department = await departmentRepo.create({
          org_id: orgId,
          name: dept.name,
          code: dept.code ? dept.code.toUpperCase() : undefined,
          description: dept.description,
          is_active: true
        });
        
        // Verify the department was actually created with correct org_id
        if (department.org_id?.toString() !== orgId?.toString()) {
          logError('handleStep2 - Created department has wrong org_id!', null, {
            deptName: dept.name,
            createdOrgId: department.org_id?.toString(),
            expectedOrgId: orgId?.toString()
          });
        }
        
        departments.push(department);
        logInfo('handleStep2 - created new department', {
          name: dept.name,
          deptId: department._id?.toString(),
          orgId: department.org_id?.toString()
        });
      } catch (error) {
        // Catch MongoDB duplicate key errors - try to reactivate
        if (error.code === 11000) {
          logInfo('handleStep2 - duplicate key error, searching for existing department', {
            deptName: dept.name,
            errorMessage: error.message
          });
          
          // Query database directly to find the existing department
          const existing = await departmentRepo.findAllByOrgId(orgId);
          const foundDept = existing.find(d => d.name.toLowerCase() === deptNameLower);
          
          if (foundDept && foundDept.org_id?.toString() === orgId?.toString()) {
            await departmentRepo.update(foundDept._id, { is_active: true });
            reactivated.push(dept.name);
            logInfo('handleStep2 - reactivated department from duplicate key error', {
              name: dept.name,
              deptId: foundDept._id?.toString()
            });
          } else {
            skipped.push(dept.name);
            logWarn('handleStep2 - duplicate key but department not found in query', {
              name: dept.name,
              foundDept: foundDept ? {
                name: foundDept.name,
                orgId: foundDept.org_id?.toString(),
                expectedOrgId: orgId?.toString()
              } : null
            });
          }
          continue;
        }
        throw error;
      }
    }
    
    // Final verification - query database again to see what's actually there
    const finalActiveDepartments = await departmentRepo.findByOrgId(orgId);
    const finalAllDepartments = await departmentRepo.findAllByOrgId(orgId);
    
    // Compare what was requested vs what's in the database
    const requestedNames = (stepData.departments || []).map(d => d.name.toLowerCase());
    const finalActiveNames = finalActiveDepartments.map(d => d.name.toLowerCase());
    const missingDepartments = requestedNames.filter(name => !finalActiveNames.includes(name));
    
    logInfo('handleStep2 - final state verification', { 
      orgId: orgId?.toString(),
      requestedCount: stepData.departments?.length || 0,
      requestedNames: requestedNames,
      createdCount: departments.length,
      skippedCount: skipped.length,
      skippedNames: skipped,
      reactivatedCount: reactivated.length,
      reactivatedNames: reactivated,
      finalActiveCount: finalActiveDepartments.length,
      finalActiveNames: finalActiveNames,
      finalAllCount: finalAllDepartments.length,
      missingDepartments: missingDepartments,
      allFinalDepartments: finalAllDepartments.map(d => ({
        name: d.name,
        orgId: d.org_id?.toString(),
        isActive: d.is_active,
        _id: d._id?.toString()
      }))
    });
    
    // Warn if there's a mismatch - this indicates departments were incorrectly skipped
    if (missingDepartments.length > 0) {
      logWarn('handleStep2 - WARNING: Some requested departments are missing from database!', {
        missing: missingDepartments,
        orgId: orgId?.toString(),
        skippedNames: skipped,
        reactivatedNames: reactivated,
        createdNames: departments.map(d => d.name)
      });
      
      // Correct the skipped count - remove departments that don't actually exist
      const actuallySkipped = skipped.filter(name => {
        const nameLower = name.toLowerCase();
        return finalActiveNames.includes(nameLower);
      });
      const incorrectlySkipped = skipped.filter(name => {
        const nameLower = name.toLowerCase();
        return !finalActiveNames.includes(nameLower);
      });
      
      if (incorrectlySkipped.length > 0) {
        logError('handleStep2 - ERROR: Departments were incorrectly marked as skipped!', null, {
          incorrectlySkipped,
          orgId: orgId?.toString()
        });
        // Don't include incorrectly skipped departments in the response
        skipped = actuallySkipped;
      }
    }
    
    const totalExisting = skipped.length + reactivated.length;
    
    return { 
      success: true, 
      data: { 
        count: departments.length,
        skipped: skipped.length,
        reactivated: reactivated.length,
        message: totalExisting > 0 
          ? `${totalExisting} department(s) already exist and were ${reactivated.length > 0 ? 'reactivated' : 'skipped'}.`
          : undefined
      } 
    };
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
