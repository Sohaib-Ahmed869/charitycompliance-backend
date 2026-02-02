/**
 * Board Member Schema (Tenant DB)
 * 
 * Responsible persons (directors, board members, trustees, etc.)
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../../../utils/mongooseEncryptPlugin.js';

const boardMemberSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  title: {
    type: String,
    enum: ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof', 'Other'],
    trim: true
  },
  given_names: {
    type: String,
    required: true,
    trim: true,
    encrypted: true
  },
  family_name: {
    type: String,
    required: true,
    trim: true,
    encrypted: true
  },
  date_of_birth: {
    type: Date,
    required: true,
    encrypted: true
  },
  // Governance/responsible person role title (not limited to board positions)
  position: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  /** Link to Position document so we can load granted_permissions at login */
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    default: null,
    sparse: true
  },
  custom_position_title: {
    type: String,
    trim: true
  },
  appointment_date: {
    type: Date,
    required: true
  },
  term_end_date: {
    type: Date
  },
  email: {
    type: String,
    required: true,
    encrypted: true,
    searchable: true
  },
  phone: {
    type: String,
    encrypted: true
  },
  residential_address: {
    line1: {
      type: String,
      required: true,
      encrypted: true
    },
    suburb: {
      type: String,
      required: true,
      encrypted: true
    },
    state: {
      type: String,
      required: true,
      enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
    },
    postcode: {
      type: String,
      required: true,
      encrypted: true
    }
  },
  residential_address_changed_date: {
    type: Date
  },
  // System user account link (if they have platform access)
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    sparse: true
  },
  // Invitation fields
  invitation_token: {
    type: String,
    sparse: true,
    index: true
  },
  invitation_sent_at: {
    type: Date
  },
  invitation_expires_at: {
    type: Date
  },
  invitation_accepted_at: {
    type: Date
  },
  invitation_status: {
    type: String,
    enum: ['pending', 'sent', 'accepted', 'expired', 'not_invited'],
    default: 'not_invited'
  },
  // Whether this member should have system access
  has_system_access: {
    type: Boolean,
    default: true
  },
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'resigned', 'removed'],
    default: 'active'
  },
  /** S3 key for profile/avatar image (shown in header and user lists) */
  profile_picture_key: {
    type: String,
    default: null,
    trim: true
  }
}, {
  timestamps: true,
  collection: 'board_members'
});

boardMemberSchema.plugin(mongooseEncryptPlugin);

boardMemberSchema.index({ org_id: 1, is_active: 1 });
boardMemberSchema.index({ email: 1 });
boardMemberSchema.index({ invitation_token: 1 });

export default boardMemberSchema;
