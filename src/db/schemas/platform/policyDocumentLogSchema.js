/**
 * Policy Document Log Schema (Tenant DB)
 * Records each document update: who updated, when, version, notes
 */

import mongoose from 'mongoose';

const policyDocumentLogSchema = new mongoose.Schema(
  {
    policy_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Policy',
      required: true,
      index: true
    },
    version: {
      type: String,
      required: true
    },
    file_name: {
      type: String
    },
    notes: {
      type: String
    },
    action: {
      type: String
    },
    description: {
      type: String
    },
    changes: {
      type: String
    },
    e_signature: {
      type: String
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId
    },
    updated_by_name: {
      type: String
    },
    updated_by_position: {
      type: String
    },
    updated_by_title: {
      type: String
    }
  },
  {
    timestamps: true,
    collection: 'policy_document_logs'
  }
);

policyDocumentLogSchema.index({ policy_id: 1, createdAt: -1 });

export default policyDocumentLogSchema;
