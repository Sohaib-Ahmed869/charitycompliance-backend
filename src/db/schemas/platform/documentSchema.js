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
  // Version tracking
  version: {
    type: Number,
    default: 1
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
    enum: ['draft', 'submitted', 'review_pending', 'reviewed', 'approved', 'archived'],
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
