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
    required: function() {
      // Position is only required if not a volunteer
      return !this.is_volunteer;
    },
    trim: true,
    maxlength: 100
  },
  /** Department name (for display and edit form pre-selection; derived from position if not set) */
  department: {
    type: String,
    trim: true
  },
  /** Whether this person is a volunteer with no system access and no specific position */
  is_volunteer: {
    type: Boolean,
    default: false
  },
  /** Link to Position document so we can load granted_permissions at login */
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    default: null,
    sparse: true
  },
  /** Whether this person is the head of their department (used for pre-approval step in risk/policy workflows) */
  is_head_of_department: {
    type: Boolean,
    default: false
  },
  /** Whether this responsible person is a board member (used for complaints board sign-off routing) */
  is_board_member: {
    type: Boolean,
    default: false,
    index: true
  },
  custom_position_title: {
    type: String,
    trim: true
  },
  appointment_date: {
    type: Date
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
  /** Blind index for email (HMAC with master key); used for duplicate checks within org */
  email_hash: {
    type: String,
    index: true,
    sparse: true
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
  },

  /** Working With Children Check certificate */
  wwcc: {
    file_key: { type: String, default: null },
    file_name: { type: String, default: null },
    file_type: { type: String, default: null },
    uploaded_at: { type: Date, default: null },
    expiry_date: { type: Date, default: null },
    card_number: { type: String, default: null, trim: true },
    status: {
      type: String,
      enum: ['not_uploaded', 'valid', 'expired'],
      default: 'not_uploaded'
    }
  },

  /** Police Check certificate */
  police_check: {
    file_key: { type: String, default: null },
    file_name: { type: String, default: null },
    file_type: { type: String, default: null },
    uploaded_at: { type: Date, default: null },
    expiry_date: { type: Date, default: null },
    certificate_number: { type: String, default: null, trim: true },
    status: {
      type: String,
      enum: ['not_uploaded', 'valid', 'expired'],
      default: 'not_uploaded'
    }
  },

  /** Employment/engagement contract file */
  contract: {
    file_key: { type: String, default: null },
    file_name: { type: String, default: null },
    file_type: { type: String, default: null },
    uploaded_at: { type: Date, default: null }
  },

  /** Whether induction form has been completed */
  induction_form_filled: {
    type: Boolean,
    default: false
  },
  /** Optional notes/comments for induction form completion state */
  induction_form_comments: {
    type: String,
    trim: true,
    default: ''
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
