/**
 * User Repository
 * 
 * Database operations for users in tenant databases.
 * Uses tenant-specific database connection.
 */

import mongoose from 'mongoose';
import mongooseEncryptPlugin from '../utils/mongooseEncryptPlugin.js';
import crypto from 'crypto';
import config from '../config/index.js';

const createUserSchema = () => {
  const userSchema = new mongoose.Schema({
      email: {
        type: String,
        required: true,
        unique: true,
        index: true,
        encrypted: true,
        searchable: true
      },
      email_hash: {
        type: String,
        index: true,
        sparse: true
      },
      password_hash: {
        type: String,
        required: true
      },
      first_name: {
        type: String,
        encrypted: true
      },
      last_name: {
        type: String,
        encrypted: true
      },
      mfa_enabled: {
        type: Boolean,
        default: false
      },
      mfa_secret: {
        type: String,
        encrypted: true
      },
      locked: {
        type: Boolean,
        default: false
      },
      locked_until: {
        type: Date
      },
      failed_login_attempts: {
        type: Number,
        default: 0
      },
      last_login_at: {
        type: Date
      },
      status: {
        type: String,
        enum: ['active', 'inactive', 'suspended'],
        default: 'active'
      },
      // Marks the original organisation owner (first registered user) – used to grant admin/*:* safely
      is_org_owner: {
        type: Boolean,
        default: false
      },
      // S3 key for profile/avatar (used when org owner has no BoardMember record)
      profile_picture_key: {
        type: String,
        default: null,
        trim: true
      },
      // Password reset
      password_reset_token: { type: String, default: null },
      password_reset_expires: { type: Date, default: null },

      // Audit: who created this user (admin invite/manual create) or self (set to own id)
      created_by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true
      }
    }, {
      timestamps: true
    });

    userSchema.plugin(mongooseEncryptPlugin);
    // email_hash index already defined via field option above - don't duplicate

    return userSchema;
};

export class UserRepository {
  constructor(tenantDb) {
    // Reuse compiled model per tenant connection to avoid OverwriteModelError
    this.User = tenantDb.models.User || tenantDb.model('User', createUserSchema());
  }

  async findByEmail(email) {
    return this.User.findOne({ email_hash: this.createEmailHash(email) });
  }

  async findById(userId) {
    return this.User.findById(userId);
  }

  async findOrgOwner() {
    return this.User.findOne({ is_org_owner: true }).select('email first_name last_name');
  }

  async findByResetToken(token) {
    return this.User.findOne({
      password_reset_token: token,
      password_reset_expires: { $gt: new Date() }
    });
  }

  async create(userData) {
    const user = new this.User(userData);
    // Ensure email_hash is set with master key (plugin will handle this, but explicit for clarity)
    // The mongoose plugin will create email_hash using masterKey during pre-save hook
    return user.save();
  }

  async listActiveUsers(excludeUserId) {
    const query = {
      status: 'active',
      $or: [
        { is_auditor: { $exists: false } },
        { is_auditor: false }
      ]
    };
    if (excludeUserId) {
      query._id = { $ne: excludeUserId };
    }
    return this.User.find(query)
      .select('first_name last_name email status profile_picture_key is_auditor')
      .sort({ first_name: 1, last_name: 1 })
      .exec();
  }

  async update(userId, updateData) {
    const data = { ...(updateData || {}) };
    if (Object.prototype.hasOwnProperty.call(data, 'email') && data.email) {
      data.email_hash = this.createEmailHash(data.email);
    }
    return this.User.findByIdAndUpdate(
      userId,
      { $set: data },
      { new: true, runValidators: true }
    );
  }

  async updateLastLogin(userId) {
    return this.User.findByIdAndUpdate(
      userId,
      { 
        $set: { last_login_at: new Date() },
        $set: { failed_login_attempts: 0 }
      },
      { new: true }
    );
  }

  async incrementFailedAttempts(userId) {
    return this.User.findByIdAndUpdate(
      userId,
      { $inc: { failed_login_attempts: 1 } },
      { new: true }
    );
  }

  async lockUser(userId, lockUntil) {
    return this.User.findByIdAndUpdate(
      userId,
      { 
        $set: { 
          locked: true,
          locked_until: lockUntil
        }
      },
      { new: true }
    );
  }

  createEmailHash(email) {
    // Use master key for email hashing to enable cross-tenant search
    // Email hash must be consistent across all tenants for login lookup
    const masterKey = config.encryption.masterKeyHex;
    return crypto.createHmac('sha256', Buffer.from(masterKey, 'hex'))
      .update(email.toLowerCase().trim())
      .digest('hex');
  }
}
