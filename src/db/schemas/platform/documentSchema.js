/**
 * Document Schema (Tenant DB)
 * 
 * Stores uploaded documents with categorization and metadata
 */

import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  category: {
    type: String,
    required: true,
    enum: [
      'governing_document',
      'constitution',
      'trust_deed',
      'certificate_of_incorporation',
      'board_minutes',
      'financial_statement',
      'responsible_person_consent',
      'evidence_of_activities',
      'supporting_document',
      'withholding_evidence',
      'registration_license',
      /** Licences, fundraising permits, regulatory registrations (Governance → Documents). Australian spelling: licences. */
      'licences_permits',
      /** Monthly / yearly fiscal reports (uploaded from Finance → Fiscal reports); use document_type for schedule. */
      'fiscal_report',
      /** Quarterly BAS (Business Activity Statement) tracking — GST/PAYG; use document_type bas_period_quarterly + metadata.period_key. */
      'bas_lodgement',
      'other'
    ],
    index: true
  },
  document_type: {
    type: String,
    required: true,
    trim: true
  },
  registration_number: {
    type: String,
    trim: true
  },
  /** licences_permits: kind of licence/permit (e.g. fundraising, ACL). */
  licence_type: {
    type: String,
    trim: true
  },
  issuing_authority: {
    type: String,
    trim: true
  },
  renewal_requirements: {
    type: String,
    trim: true
  },
  /** Australian state/territory or National for permits */
  state_or_territory: {
    type: String,
    trim: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String
  },
  file_name: {
    type: String,
    required: true
  },
  file_path: {
    type: String,
    required: true
  },
  file_size: {
    type: Number,
    required: true
  },
  mime_type: {
    type: String,
    required: true
  },
  // Version tracking.
  //   `version`       — major version. Bumps when the underlying
  //                     FILE is replaced (new upload via the version
  //                     history panel).
  //   `minor_version` — incremented on metadata edits (title, dates,
  //                     description, etc.) without a file swap. Resets
  //                     to 0 whenever the major bumps.
  // Displayed as `v{version}.{minor_version}` (e.g. "v1.0", "v1.1", "v2.0").
  version: {
    type: Number,
    default: 1
  },
  minor_version: {
    type: Number,
    default: 0
  },
  parent_document_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    sparse: true
  },
  // Dates
  date_adopted: {
    type: Date
  },
  date_last_amended: {
    type: Date
  },
  effective_date: {
    type: Date
  },
  review_date: {
    type: Date
  },
  last_reviewed: {
    type: Date
  },
  expiry_date: {
    type: Date
  },
  // Related entities
  related_board_member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BoardMember',
    sparse: true
  },
  related_statutory_record_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StatutoryRecord',
    sparse: true
  },
  // Status
  status: {
    type: String,
    /** resubmission_required: fiscal/BAS document needs a revised file after decline (see metadata.resubmission_reason). */
    enum: ['draft', 'submitted', 'review_pending', 'resubmission_required', 'reviewed', 'approved', 'archived'],
    default: 'submitted'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  uploaded_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  collection: 'documents'
});

documentSchema.index({ org_id: 1, category: 1 });
documentSchema.index({ org_id: 1, status: 1 });
documentSchema.index({ parent_document_id: 1 });

export default documentSchema;
