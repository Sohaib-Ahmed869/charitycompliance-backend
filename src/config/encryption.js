/**
 * Encryption Configuration
 * 
 * Manages the Master Key used to encrypt organization-specific keys.
 * The Master Key is stored in environment variables and must NEVER be committed.
 */

import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Trim to avoid .env newline/whitespace breaking decryption (critical on Windows)
const MASTER_KEY_HEX = (process.env.MASTER_KEY_HEX || '').trim();

if (!MASTER_KEY_HEX) {
  throw new Error('MASTER_KEY_HEX environment variable is required');
}

if (MASTER_KEY_HEX.length !== 64) {
  throw new Error('MASTER_KEY_HEX must be exactly 64 characters (32 bytes in hex). Got length: ' + MASTER_KEY_HEX.length);
}

/**
 * Get Master Key as Buffer
 * @returns {Buffer}
 */
export const getMasterKey = () => {
  return Buffer.from(MASTER_KEY_HEX, 'hex');
};

/**
 * Get Master Key as 64-char hex string (for field encrypt/decrypt)
 * @returns {string}
 */
export const getMasterKeyHex = () => {
  return MASTER_KEY_HEX;
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
  getMasterKeyHex,
  validateMasterKey,
  generateOrgKey
};
