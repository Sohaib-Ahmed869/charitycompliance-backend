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
import { UserRepository } from '../repositories/userRepository.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { decrypt, isEncrypted } from '../utils/encryption.js';
import emailService from './emailService.js';

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

  async getPositions() {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) return [];

    const positionRepo = new PositionRepository(tenantDb);
    const departmentRepo = new DepartmentRepository(tenantDb);
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const bmRepo = new BoardMemberRepository(tenantDb);

    const positions = await positionRepo.findByOrgId(org._id);
    const departments = await departmentRepo.findByOrgId(org._id);
    const deptMap = {};
    departments.forEach(d => { deptMap[d._id.toString()] = d.name; });

    const boardMembers = await bmRepo.findByOrgId(org._id);

    return positions.map(pos => {
      const deptName = pos.department_id ? (deptMap[pos.department_id.toString()] || '') : '';
      // Match board member → position by position_id first, then fallback to text position+department
      const bm = boardMembers.find(b => {
        const bmPosId = b.position_id?._id?.toString?.() || b.position_id?.toString?.();
        if (bmPosId && bmPosId === pos._id.toString()) return true;
        // Fallback: match by text position name + department name
        const bmPos = (b.custom_position_title || b.position || '').trim().toLowerCase();
        const bmDept = (b.department || '').trim().toLowerCase();
        return bmPos === pos.title.trim().toLowerCase() && bmDept === deptName.trim().toLowerCase();
      });

      const result = {
        id: pos._id.toString(),
        name: pos.title,
        department: deptName,
        departmentId: pos.department_id?.toString() || '',
        level: pos.level || 1,
        modulePermissions: {},
        assignedUser: null,
      };

      (pos.module_permissions || []).forEach(mp => {
        if (mp?.module_id) {
          result.modulePermissions[mp.module_id] = {
            view: !!mp.view, edit: !!mp.edit, delete: !!mp.delete
          };
        }
      });

      if (bm) {
        result.assignedUser = {
          boardMemberId: bm._id.toString(),
          given_names: bm.given_names || '',
          family_name: bm.family_name || '',
          email: bm.email || '',
          phone: bm.phone || '',
          title: bm.title || '',
          date_of_birth: bm.date_of_birth || '',
          appointment_date: bm.appointment_date || '',
          residential_address: bm.residential_address || { line1: '', suburb: '', state: '', postcode: '' },
          is_head_of_department: !!bm.is_head_of_department,
          is_board_member: !!bm.is_board_member,
          method: bm.invitation_status === 'not_invited' ? 'manual' : 'invite',
        };
      }

      return result;
    });
  }

  async createPosition(posData) {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) throw new Error('Organization not found');

    const positionRepo = new PositionRepository(tenantDb);
    const departmentRepo = new DepartmentRepository(tenantDb);

    let departmentId = null;
    if (posData.department) {
      const allDepts = await departmentRepo.findByOrgId(org._id);
      const dept = allDepts.find(d => d.name === posData.department);
      if (dept) departmentId = dept._id;
    }

    const positionData = {
      org_id: org._id,
      title: posData.name,
      department_id: departmentId,
      level: posData.level || 1,
      is_active: true,
    };

    try {
      const position = await positionRepo.create(positionData);
      return { id: position._id.toString(), name: position.title, department: posData.department, departmentId: departmentId?.toString() || '' };
    } catch (err) {
      if (err.code === 11000) {
        const existing = (await positionRepo.findByOrgId(org._id)).find(p =>
          p.title === posData.name && departmentId && p.department_id?.toString() === departmentId.toString()
        );
        if (existing) {
          if (!existing.is_active) await positionRepo.update(existing._id, { is_active: true });
          return { id: existing._id.toString(), name: existing.title, department: posData.department, departmentId: departmentId?.toString() || '' };
        }
      }
      throw err;
    }
  }

  async deletePosition(positionId) {
    const tenantDb = await this.getTenantDb();
    const positionRepo = new PositionRepository(tenantDb);
    await positionRepo.delete(positionId);
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

  // Step 1: Organization Details (name, organizationType, size, turnover, ATSI community flag)
  async handleStep1(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const orgRepo = new OrganizationRepository(tenantDb);

    const existing = await orgRepo.findOne();
    const prevMeta =
      existing?.metadata && typeof existing.metadata === 'object'
        ? { ...(existing.metadata.toObject?.() ?? existing.metadata) }
        : {};

    // Map size to employee_count range
    const sizeMapping = {
      '1-10': 5,
      '11-50': 30,
      '51-200': 125,
      '201-500': 350,
      '500+': 500
    };

    const metadata = {
      ...prevMeta,
      size: stepData.size,
      organizationType: stepData.organizationType,
      turnover: stepData.turnover
    };
    if (typeof stepData.works_with_aboriginal_torres_strait_islander === 'boolean') {
      metadata.works_with_aboriginal_torres_strait_islander =
        stepData.works_with_aboriginal_torres_strait_islander;
    }

    await orgRepo.update({
      name: stepData.name,
      employee_count: sizeMapping[stepData.size] || 0,
      website: stepData.website || undefined,
      address_street: stepData.address_street || undefined,
      address_city: stepData.address_city || undefined,
      address_state: stepData.address_state || undefined,
      address_postcode: stepData.address_postcode || undefined,
      metadata
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
    
    // Pre-load existing positions so we can skip already-persisted ones
    const existingPositions = await positionRepo.findByOrgId(orgId);
    const positions = [];
    const skipped = [];
    const reactivated = [];
    
    for (const pos of stepData.positions || []) {
      let departmentId = null;
      
      if (pos.department) {
        const department = allDepartments.find(d => 
          d.name === pos.department
        );
        if (department) {
          departmentId = department._id;
        }
      }

      // If a position with same title+department already exists and is active, skip it
      const alreadyExists = existingPositions.find(p =>
        p.title === pos.name &&
        (departmentId ? p.department_id?.toString() === departmentId.toString() : !p.department_id) &&
        p.is_active
      );
      if (alreadyExists) {
        skipped.push(pos.name);
        positions.push(alreadyExists);
        continue;
      }
      
      const positionData = {
        org_id: orgId,
        title: pos.name,
        description: pos.description || undefined,
        level: pos.level || 1,
        is_management: false,
        can_approve_expenses: pos.canApproveExpenses || false,
        can_approve_risks: pos.canApproveRisks || false,
        can_approve_grants: pos.canApproveGrants || false,
        can_approve_policies: pos.canApprovePolicies || false,
        can_approve_hr: pos.canApproveHR || false,
        max_approval_amount: 0,
        department_id: departmentId,
        is_active: true
      };
      
      if (pos.code && pos.code.trim()) {
        positionData.code = pos.code.trim().toUpperCase();
      }
      
      try {
        const position = await positionRepo.create(positionData);
        positions.push(position);
       
      } catch (error) {
        // Handle duplicate key errors (for org_id + code unique index)
        if (error.code === 11000) {
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
      
      // Filter out rules that don't have any approvers - they would violate schema validation
      rules = rules.filter(rule => 
        rule.requires_approval_from && rule.requires_approval_from.length > 0
      );
    } else {
      // If no rules provided, don't create a default matrix.
      // Templates are required to define their own rules with at least one approver.
      // This prevents creating invalid workflows that would fail to execute.
      rules = [];
    }

    // Create ONE ApprovalMatrix document per rule/workflow instead of packing all
    // rules into a single "Default Approval Matrix".
    // Map action types to workflow categories and required workflow types
    const categoryMapping = {
      risk: 'risk_management',
      risk_management: 'risk_management',
      expense: 'expense_approval',
      purchase: 'expense_approval',
      grant: 'funding_agreement',
      coi: 'coi',
      partner_vetting: 'partner_vetting',
      policy: 'policy_approval',
      policy_approval: 'policy_approval',
      hr: 'hr_approval',
      contract: 'other',
      leave: 'hr_approval',
      project: 'project_approval',
      risk_treatment: 'risk_treatment',
      funding_agreement: 'funding_agreement',
      other: 'other'
    };

    // Map categories to default workflow types (when applicable)
    const workflowTypeDefaults = {
      risk_management: 'medium',  // Default to medium risk
      expense_approval: 'moderate_cash',  // Default to moderate cash tier
      funding_agreement: 'moderate_cash',
      project_approval: 'moderate_cash'
    };

    // Categories that can only have ONE active workflow per org
    const singleWorkflowCategories = ['coi', 'partner_vetting', 'policy_approval', 'hr_approval', 'risk_treatment'];

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

      // Get workflow category from mapping
      const workflowCategory = categoryMapping[typeKey] || 'other';

      try {
        // Check for single-workflow category conflict
        if (singleWorkflowCategories.includes(workflowCategory)) {
          const existingCount = await approvalMatrixRepo.ApprovalMatrix.countDocuments({
            org_id: orgId,
            workflow_category: workflowCategory,
            is_active: true
          });
          
          if (existingCount > 0) {
            console.warn(`Skipping ${typeKey} matrix - only one active workflow allowed for category ${workflowCategory}`);
            continue;
          }
        }

        // Skip if no valid approvers found (they're already resolved to IDs in earlier resolution logic)
        if (!rule.requires_approval_from || rule.requires_approval_from.length === 0) {
          console.warn(`Skipping ${typeKey} matrix - no valid positions found for approvers`);
          continue;
        }

        // Build matrix data with proper validation
        const matrixData = {
          org_id: orgId,
          name,
          description: stepData.description || '',
          workflow_category: workflowCategory,
          rules: [{
            action_type: rule.action_type,
            min_amount: rule.min_amount || 0,
            max_amount: rule.max_amount,
            requires_approval_from: rule.requires_approval_from,
            approval_type: 'sequential',
            is_active: true
          }],
          is_default: i === 0,
          is_active: true
        };

        // Add workflow_type if required by category
        if (workflowTypeDefaults[workflowCategory]) {
          matrixData.workflow_type = workflowTypeDefaults[workflowCategory];
        }

        const matrix = await approvalMatrixRepo.create(matrixData);
        createdMatrices.push(matrix._id);
      } catch (error) {
        console.error(`Failed to create approval matrix for ${typeKey}:`, error.message);
        // Continue creating other matrices even if one fails
      }
    }

    return { success: true, matrices: createdMatrices };
  }

  // Step 5: Review - Mark initial onboarding as complete
  async handleStep5(orgId, stepData) {
    const tenantDb = await this.getTenantDb();
    const progressRepo = new OnboardingProgressRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);
    
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

    // Send onboarding complete email to org owner
    try {
      const org = await orgRepo.findOne();
      const userRepo = new UserRepository(tenantDb);
      const owner = await userRepo.findOrgOwner();
      if (org && owner) {
        const keyHex = getMasterKeyHex();
        const userObj = owner.toObject ? owner.toObject() : { ...owner };
        const decrypted = { ...userObj };
        if (keyHex && keyHex.length === 64) {
          if (userObj.email && isEncrypted(userObj.email)) {
            try { decrypted.email = decrypt(userObj.email, keyHex); } catch (e) { logError('Failed to decrypt email for onboarding email', e); }
          }
          if (userObj.first_name && isEncrypted(userObj.first_name)) {
            try { decrypted.first_name = decrypt(userObj.first_name, keyHex); } catch (e) { logError('Failed to decrypt first_name', e); }
          }
          if (userObj.last_name && isEncrypted(userObj.last_name)) {
            try { decrypted.last_name = decrypt(userObj.last_name, keyHex); } catch (e) { logError('Failed to decrypt last_name', e); }
          }
        }
        const recipientName = [decrypted.first_name, decrypted.last_name].filter(Boolean).join(' ') || 'there';
        if (decrypted.email) {
          await emailService.sendOnboardingCompleteEmail({
            to: decrypted.email,
            recipientName,
            organizationName: org.name || 'Your Organisation'
          });
          logInfo('Onboarding complete email sent', { orgId, to: decrypted.email });
        }
      }
    } catch (emailError) {
      logError('Failed to send onboarding complete email', emailError, { orgId });
      // Don't fail the request if email fails
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
