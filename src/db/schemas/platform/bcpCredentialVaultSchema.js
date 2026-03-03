/**
 * BCP Credential Vault Schema
 * 
 * Encrypted storage for sensitive credentials
 * Requires multi-trustee approval for access
 */

import mongoose from 'mongoose';

const accessRequestSchema = new mongoose.Schema({
  requested_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'denied', 'expired'],
    default: 'pending'
  },
  required_approvals: {
    type: Number,
    default: 2
  },
  approvals: [{
    trustee_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    approved: Boolean,
    approved_at: Date,
    comments: String
  }],
  requested_at: {
    type: Date,
    default: Date.now
  },
  expires_at: {
    type: Date
  },
  accessed_at: {
    type: Date
  }
}, { _id: true });

const accessLogSchema = new mongoose.Schema({
  accessed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  access_type: {
    type: String,
    enum: ['view', 'copy', 'update', 'emergency_access'],
    required: true
  },
  access_request_id: {
    type: mongoose.Schema.Types.ObjectId
  },
  ip_address: String,
  user_agent: String,
  accessed_at: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const bcpCredentialVaultSchema = new mongoose.Schema({
  org_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  category: {
    type: String,
    enum: ['banking', 'hosting', 'domain', 'social_media', 'regulatory', 'subscription', 'legal', 'insurance', 'other'],
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String
  },
  
  // Encrypted credentials
  credentials: {
    username_encrypted: {
      type: String
    },
    password_encrypted: {
      type: String
    },
    url: {
      type: String
    },
    additional_info_encrypted: {
      type: String
    },
    encryption_key_id: {
      type: String
    }
  },
  
  owner_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position',
    required: true
  },
  backup_owner_position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Position'
  },
  
  renewal_date: {
    type: Date
  },
  renewal_reminder_days: {
    type: Number,
    default: 30
  },
  
  criticality: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  
  access_requests: [accessRequestSchema],
  access_logs: [accessLogSchema],
  
  last_password_change: {
    type: Date
  },
  password_expiry_days: {
    type: Number,
    default: 90
  },
  
  status: {
    type: String,
    enum: ['active', 'expired', 'archived'],
    default: 'active'
  },
  
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

bcpCredentialVaultSchema.index({ org_id: 1, category: 1 });
bcpCredentialVaultSchema.index({ org_id: 1, renewal_date: 1 });

export default bcpCredentialVaultSchema;
