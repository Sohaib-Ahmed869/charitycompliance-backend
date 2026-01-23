/**
 * Onboarding Progress Schema (Tenant DB)
 * 
 * Tracks progress through the ACNC-compliant onboarding flow
 */

import mongoose from 'mongoose';

const onboardingProgressSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  // Initial 4 steps (must complete before dashboard access)
  initial_org_details_complete: {
    type: Boolean,
    default: false
  },
  initial_approval_matrix_complete: {
    type: Boolean,
    default: false
  },
  initial_departments_complete: {
    type: Boolean,
    default: false
  },
  initial_positions_complete: {
    type: Boolean,
    default: false
  },
  initial_onboarding_complete: {
    type: Boolean,
    default: false
  },
  initial_onboarding_completed_at: {
    type: Date
  },
  // Full profile completion steps (can complete after initial onboarding)
  abn_verification_complete: {
    type: Boolean,
    default: false
  },
  legal_structure_complete: {
    type: Boolean,
    default: false
  },
  org_details_complete: {
    type: Boolean,
    default: false
  },
  responsible_people_complete: {
    type: Boolean,
    default: false
  },
  registration_date_complete: {
    type: Boolean,
    default: false
  },
  operating_locations_complete: {
    type: Boolean,
    default: false
  },
  activities_complete: {
    type: Boolean,
    default: false
  },
  subtypes_complete: {
    type: Boolean,
    default: false
  },
  finances_complete: {
    type: Boolean,
    default: false
  },
  governance_complete: {
    type: Boolean,
    default: false
  },
  tax_complete: {
    type: Boolean,
    default: false
  },
  withhold_info_complete: {
    type: Boolean,
    default: false
  },
  documents_complete: {
    type: Boolean,
    default: false
  },
  authorised_contact_complete: {
    type: Boolean,
    default: false
  },
  declaration_complete: {
    type: Boolean,
    default: false
  },
  platform_setup_complete: {
    type: Boolean,
    default: false
  },
  // Calculated fields
  initial_completion_percentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  full_profile_completion_percentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  current_step: {
    type: Number,
    default: 1,
    min: 1,
    max: 5  // Initial onboarding: 4 steps + 1 review step = 5 total
  },
  started_at: {
    type: Date,
    default: Date.now
  },
  completed_at: {
    type: Date
  }
}, {
  timestamps: true,
  collection: 'onboarding_progress'
});

// Index for quick lookup
onboardingProgressSchema.index({ org_id: 1 }, { unique: true });

export default onboardingProgressSchema;
