/**
 * Encryption Configuration
 * 
 * Manages the Master Key used to encrypt organization-specific keys.
 * The Master Key is stored in environment variables and must NEVER be committed.
 */

import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const MASTER_KEY_HEX = process.env.MASTER_KEY_HEX;

if (!MASTER_KEY_HEX) {
  throw new Error('MASTER_KEY_HEX environment variable is required');
}

if (MASTER_KEY_HEX.length !== 64) {
  throw new Error('MASTER_KEY_HEX must be exactly 64 characters (32 bytes in hex)');
}

/**
 * Get Master Key as Buffer
 * @returns {Buffer}
 */
export const getMasterKey = () => {
  return Buffer.from(MASTER_KEY_HEX, 'hex');
};

/**
 * Validate Master Key format
 * @returns {boolean}
 */
export const validateMasterKey = () => {
  try {
    const key = Buffer.from(MASTER_KEY_HEX, 'hex');
    return key.length === 32; // 32 bytes = 256 bits
  } catch (error) {
    return false;
  }
};

/**
 * Generate a new organization-specific encryption key
 * @returns {string} 64-character hex string (32 bytes)
 */
export const generateOrgKey = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Validate on module load
if (!validateMasterKey()) {
  throw new Error('Invalid MASTER_KEY_HEX format. Must be 64-character hex string.');
}

export default {
  getMasterKey,
  validateMasterKey,
  generateOrgKey
};
