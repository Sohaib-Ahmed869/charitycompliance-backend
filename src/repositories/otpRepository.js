/**
 * OTP Repository
 * 
 * Database operations for one-time passwords
 */

import mongoose from 'mongoose';
import otpSchema from '../db/schemas/platform/otpSchema.js';

export class OtpRepository {
  constructor(tenantDb) {
    // Reuse compiled model per tenant connection
    this.Otp = tenantDb.models.Otp || tenantDb.model('Otp', otpSchema);
  }

  /**
   * Create a new OTP record
   * @param {string} userId - User ID
   * @param {string} email - User email
   * @param {string} code - OTP code
   * @returns {Promise<Object>} Created OTP record
   */
  async create(userId, email, code) {
    const otp = new this.Otp({
      user_id: new mongoose.Types.ObjectId(userId),
      email,
      code,
      attempts: 0
    });
    return otp.save();
  }

  /**
   * Find OTP by user ID and code
   * @param {string} userId - User ID
   * @param {string} code - OTP code
   * @returns {Promise<Object|null>} OTP record if found
   */
  async findByUserIdAndCode(userId, code) {
    return this.Otp.findOne({
      user_id: new mongoose.Types.ObjectId(userId),
      code,
      expires_at: { $gt: new Date() } // Not expired
    });
  }

  /**
   * Increment attempts for an OTP
   * @param {string} otpId - OTP ID
   * @returns {Promise<Object>} Updated OTP record
   */
  async incrementAttempts(otpId) {
    return this.Otp.findByIdAndUpdate(
      otpId,
      { $inc: { attempts: 1 } },
      { new: true }
    );
  }

  /**
   * Delete OTP by ID
   * @param {string} otpId - OTP ID
   * @returns {Promise<Object|null>} Deleted OTP record
   */
  async deleteById(otpId) {
    return this.Otp.findByIdAndDelete(otpId);
  }

  /**
   * Delete all OTPs for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteByUserId(userId) {
    return this.Otp.deleteMany({
      user_id: new mongoose.Types.ObjectId(userId)
    });
  }

  /**
   * Delete expired OTPs
   * @returns {Promise<Object>} Delete result
   */
  async deleteExpired() {
    return this.Otp.deleteMany({
      expires_at: { $lt: new Date() }
    });
  }
}
