/**
 * Board Member Declaration Schema (Tenant DB)
 * 
 * Consent and declaration records for responsible persons
 */

import mongoose from 'mongoose';

const boardMemberDeclarationSchema = new mongoose.Schema({
  board_member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BoardMember',
    required: true,
    index: true
  },
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  // Declaration checkboxes
  not_disqualified_corporations_act: {
    type: Boolean,
    required: true,
    default: false
  },
  not_disqualified_acnc: {
    type: Boolean,
    required: true,
    default: false
  },
  consented_to_role: {
    type: Boolean,
    required: true,
    default: false
  },
  consented_to_acnc_disclosure: {
    type: Boolean,
    required: true,
    default: false
  },
  // Metadata
  declared_by: {
    type: String,
    required: true
  },
  declared_at: {
    type: Date,
    default: Date.now
  },
  ip_address: {
    type: String
  }
}, {
  timestamps: true,
  collection: 'board_member_declarations'
});

boardMemberDeclarationSchema.index({ board_member_id: 1 }, { unique: true });
boardMemberDeclarationSchema.index({ org_id: 1 });

export default boardMemberDeclarationSchema;
