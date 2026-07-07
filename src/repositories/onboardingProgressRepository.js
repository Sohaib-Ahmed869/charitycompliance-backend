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
      7: 'subtypes_complete',
      8: 'finances_complete',
      9: 'governance_complete',
      10: 'tax_complete',
      11: 'withhold_info_complete',
      12: 'documents_complete',
      13: 'authorised_contact_complete',
      14: 'declaration_complete',
      15: 'platform_setup_complete'
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

    // NOTE: do NOT auto-complete initial onboarding here. Completing the four
    // data steps (org details → departments → positions → approval matrix) is
    // NOT the end of the wizard — the user still has the Review step (Step 5).
    // Flipping `initial_onboarding_complete` as soon as those four are recorded
    // (which a template setup can do all at once) made ProtectedRoute + the
    // wizard bounce the owner to /dashboard mid-flow — e.g. right after the
    // Stripe subscription gate reload, skipping the rest of onboarding.
    // `initial_onboarding_complete` is set ONLY by handleStep5() when the user
    // actually submits the Review step (via POST /onboarding/complete).

    // 4 initial onboarding steps + 5 dashboard profile steps = 9 total
    const profileSteps = [
      progress.org_details_complete,
      progress.documents_complete,
      progress.responsible_people_complete,
      progress.financial_controls_complete,
      progress.declaration_complete
    ];

    const fullProfileSteps = [...initialSteps, ...profileSteps];
    const completedFullProfileSteps = fullProfileSteps.filter(Boolean).length;
    const fullProfileCompletionPercentage = Math.round((completedFullProfileSteps / 9) * 100);
    
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
