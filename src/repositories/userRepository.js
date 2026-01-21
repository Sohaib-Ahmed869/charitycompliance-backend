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
      }
    }, {
      timestamps: true
    });

    userSchema.plugin(mongooseEncryptPlugin);
    userSchema.index({ email_hash: 1 });
    
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

  async create(userData) {
    const user = new this.User(userData);
    // Ensure email_hash is set with master key (plugin will handle this, but explicit for clarity)
    // The mongoose plugin will create email_hash using masterKey during pre-save hook
    return user.save();
  }

  async update(userId, updateData) {
    return this.User.findByIdAndUpdate(
      userId,
      { $set: updateData },
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
