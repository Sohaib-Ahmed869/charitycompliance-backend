/**
 * Onboarding Progress Repository
 * 
 * Manages onboarding progress tracking
 */

import mongoose from 'mongoose';
import onboardingProgressSchema from '../db/schemas/platform/onboardingProgressSchema.js';

export class OnboardingProgressRepository {
  constructor(tenantDb) {
    this.OnboardingProgress = tenantDb.models.OnboardingProgress || 
      tenantDb.model('OnboardingProgress', onboardingProgressSchema);
  }

  async findByOrgId(orgId) {
    return await this.OnboardingProgress.findOne({ org_id: orgId });
  }

  async create(orgId) {
    const progress = new this.OnboardingProgress({
      org_id: orgId,
      current_step: 1,
      started_at: new Date()
    });
    return await progress.save();
  }

  async updateStep(orgId, stepNumber, stepComplete = false, isInitialOnboarding = true) {
    // Initial onboarding steps (1-4)
    // Order: 1. Organization Details, 2. Departments, 3. Positions, 4. Approval Matrix
    const initialStepFields = {
      1: 'initial_org_details_complete',
      2: 'initial_departments_complete',
      3: 'initial_positions_complete',
      4: 'initial_approval_matrix_complete'
    };

    // Full profile steps (5+)
    const fullProfileStepFields = {
      1: 'abn_verification_complete',
      2: 'legal_structure_complete',
      3: 'org_details_complete',
      4: 'responsible_people_complete',
      5: 'registration_date_complete',
      6: 'operating_locations_complete',
      7: 'activities_complete',
      8: 'subtypes_complete',
      9: 'finances_complete',
      10: 'governance_complete',
      11: 'tax_complete',
      12: 'withhold_info_complete',
      13: 'documents_complete',
      14: 'authorised_contact_complete',
      15: 'declaration_complete',
      16: 'platform_setup_complete'
    };

    const stepFields = isInitialOnboarding ? initialStepFields : fullProfileStepFields;
    const update = {
      current_step: stepNumber,
      [stepFields[stepNumber]]: stepComplete
    };

    const progress = await this.OnboardingProgress.findOneAndUpdate(
      { org_id: orgId },
      { $set: update },
      { new: true, upsert: true }
    );

    // Recalculate completion percentages
    await this.recalculateProgress(orgId);
    return progress;
  }

  async recalculateProgress(orgId) {
    const progress = await this.OnboardingProgress.findOne({ org_id: orgId });
    if (!progress) return;

    // Calculate initial onboarding completion (4 steps)
    const initialSteps = [
      progress.initial_org_details_complete,
      progress.initial_departments_complete,
      progress.initial_positions_complete,
      progress.initial_approval_matrix_complete
    ];
    const completedInitialSteps = initialSteps.filter(Boolean).length;
    const initialCompletionPercentage = Math.round((completedInitialSteps / 4) * 100);
    
    progress.initial_completion_percentage = initialCompletionPercentage;
    
    // Mark initial onboarding as complete if all 4 steps are done
    if (completedInitialSteps === 4 && !progress.initial_onboarding_complete) {
      progress.initial_onboarding_complete = true;
      progress.initial_onboarding_completed_at = new Date();
    }

    // Calculate full profile completion (4 initial onboarding + 6 profile steps = 10 total)
    // Profile steps from dashboard:
    // 1. Organisation Information (org_details_complete)
    // 2. Upload Governing Documents (documents_complete)
    // 3. Add Responsible Persons (responsible_people_complete)
    // 4. Define Operating Activities (activities_complete)
    // 5. Set Up Financial Controls (financial_controls_complete)
    // 6. Configure Governance Structure (declaration_complete)
    const profileSteps = [
      progress.org_details_complete,         // Organisation Information
      progress.documents_complete,           // Upload Governing Documents
      progress.responsible_people_complete,  // Add Responsible Persons
      progress.activities_complete,          // Define Operating Activities
      progress.financial_controls_complete, // Set Up Financial Controls
      progress.declaration_complete          // Configure Governance Structure
    ];
    
    const fullProfileSteps = [
      ...initialSteps,
      ...profileSteps
    ];
    const completedFullProfileSteps = fullProfileSteps.filter(Boolean).length;
    // 4 initial + 6 profile steps = 10 total
    const fullProfileCompletionPercentage = Math.round((completedFullProfileSteps / 10) * 100);
    
    progress.full_profile_completion_percentage = fullProfileCompletionPercentage;
    
    if (fullProfileCompletionPercentage === 100 && !progress.completed_at) {
      progress.completed_at = new Date();
    }

    return await progress.save();
  }

  async markComplete(orgId) {
    return await this.OnboardingProgress.findOneAndUpdate(
      { org_id: orgId },
      {
        $set: {
          platform_setup_complete: true,
          completed_at: new Date(),
          completion_percentage: 100
        }
      },
      { new: true }
    );
  }

  async updateProfileStep(orgId, stepKey, completed) {
    const update = {
      [stepKey]: completed
    };

    const progress = await this.OnboardingProgress.findOneAndUpdate(
      { org_id: orgId },
      { $set: update },
      { new: true, upsert: true }
    );

    // Recalculate completion percentages
    await this.recalculateProgress(orgId);
    return progress;
  }
}
