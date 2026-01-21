/**
 * Statutory Record Schema (Tenant DB)
 * 
 * Tracks registrations, licenses, certifications, and statutory obligations
 */

import mongoose from 'mongoose';

const statutoryRecordSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  record_type: {
    type: String,
    required: true,
    enum: [
      'registration',
      'license',
      'certification',
      'accreditation',
      'dgr',
      'tax_endorsement',
      'incorporation',
      'other'
    ],
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  issuing_authority: {
    type: String,
    required: true,
    trim: true
  },
  registration_number: {
    type: String,
    trim: true,
    index: true
  },
  issue_date: {
    type: Date
  },
  expiry_date: {
    type: Date,
    index: true
  },
  renewal_date: {
    type: Date
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'pending', 'revoked', 'suspended'],
    default: 'active',
    index: true
  },
  // For state/territory registrations
  state_territory: {
    type: String,
    enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
  },
  // Document reference
  document_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    sparse: true
  },
  notes: {
    type: String
  },
  is_required: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  collection: 'statutory_records'
});

statutoryRecordSchema.index({ org_id: 1, record_type: 1 });
statutoryRecordSchema.index({ org_id: 1, status: 1 });
statutoryRecordSchema.index({ expiry_date: 1 });

export default statutoryRecordSchema;
