/**
 * Organization Schema (Tenant DB)
 * 
 * Organization profile and settings
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../../../utils/mongooseEncryptPlugin.js';

const organizationSchema = new mongoose.Schema({
  orgId: {
    type: String,
    trim: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  trading_name: {
    type: String,
    trim: true
  },
  former_names: {
    type: [String],
    default: []
  },
  registration_number: {
    type: String,
    trim: true
  },
  abn: {
    type: String,
    trim: true,
    index: true
  },
  acn: {
    type: String,
    trim: true
  },
  acnc_registration_number: {
    type: String,
    trim: true
  },
  org_type: {
    type: String,
    enum: [
      'company_limited_by_guarantee',
      'incorporated_association',
      'trust',
      'unincorporated_association',
      'other'
    ]
  },
  incorporation_state: {
    type: String,
    enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
  },
  incorporation_number: {
    type: String,
    trim: true
  },
  dgr_status: {
    type: String,
    enum: ['endorsed', 'not_endorsed', 'pending', 'applying'],
    default: 'not_endorsed'
  },
  dgr_item_number: {
    type: String,
    trim: true
  },
  dgr_endorsement_date: {
    type: Date
  },
  // Address fields
  address_street: {
    type: String,
    encrypted: true
  },
  address_street2: {
    type: String,
    encrypted: true
  },
  address_city: {
    type: String,
    encrypted: true
  },
  address_state: {
    type: String,
    enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
  },
  address_postcode: {
    type: String,
    encrypted: true
  },
  address_country: {
    type: String,
    default: 'Australia'
  },
  // Postal address
  postal_same_as_principal: {
    type: Boolean,
    default: true
  },
  postal_address_street: {
    type: String,
    encrypted: true
  },
  postal_address_street2: {
    type: String,
    encrypted: true
  },
  postal_address_city: {
    type: String,
    encrypted: true
  },
  postal_address_state: {
    type: String,
    enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
  },
  postal_address_postcode: {
    type: String,
    encrypted: true
  },
  email: {
    type: String,
    encrypted: true,
    searchable: true
  },
  phone: {
    type: String,
    encrypted: true
  },
  website: {
    type: String,
    trim: true
  },
  logo_path: {
    type: String
  },
  timezone: {
    type: String,
    default: 'Australia/Sydney'
  },
  primary_brand_colour: {
    type: String,
    default: '#3485FF'
  },
  // Onboarding dates
  establishment_date: {
    type: Date
  },
  charitable_start_date: {
    type: Date
  },
  is_new_organisation: {
    type: Boolean,
    default: false
  },
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: {
      large_donation_threshold: 10000,
      kyc_required_percentage: 10,
      default_currency: 'AUD',
      fiscal_year_end: '06-30',
      operating_locations: [],
      activities: [],
      beneficiaries: [],
      activity_description: '',
      charity_subtypes: [],
      is_pbi: false,
      is_health_promotion_charity: false,
      estimated_revenue: '',
      revenue_sources: [],
      reporting_tier: '',
      governance_acknowledged: false,
      governance_acknowledged_date: null,
      external_conduct_acknowledged: false,
      tax_concessions: {},
      withheld_information: [],
      withholding_reason: '',
      primary_contact_id: null,
      alternate_contacts: [],
      enabled_modules: ['policies', 'risk_management', 'hr_volunteers'],
      onboarding_completed_at: null,
      onboarding_declared_by: null
    }
  },
  // Additional metadata for onboarding data and custom fields
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['pending_setup', 'active', 'suspended', 'inactive'],
    default: 'pending_setup'
  }
}, {
  timestamps: true,
  collection: 'organization'
});

organizationSchema.plugin(mongooseEncryptPlugin);
organizationSchema.index({ name: 1 });

export default organizationSchema;
