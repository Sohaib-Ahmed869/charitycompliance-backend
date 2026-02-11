/**
 * OTP Schema (Tenant DB)
 * 
 * Stores one-time passwords for multi-factor authentication
 */

import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true
  },
  email: {
    type: String,
    required: true
  },
  code: {
    type: String,
    required: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  expires_at: {
    type: Date,
    default: () => new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    index: { expireAfterSeconds: 0 } // Auto-delete after expiry
  }
}, {
  timestamps: true
});

otpSchema.index({ user_id: 1, expires_at: 1 });
otpSchema.index({ code: 1, expires_at: 1 });

export default otpSchema;
