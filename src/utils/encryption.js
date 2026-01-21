/**
 * Encryption Utilities
 * 
 * Implements AES-256-GCM encryption for field-level encryption.
 * Format: {iv}:{authTag}:{encryptedData}
 * 
 * Features:
 * - Confidentiality: Data cannot be read without the key
 * - Integrity: Data cannot be tampered with (auth tag verification)
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt text using AES-256-GCM
 * @param {string} text - Plain text to encrypt
 * @param {string} keyHex - Encryption key as hex string (64 characters)
 * @returns {string} Encrypted data in format: {iv}:{authTag}:{encryptedData}
 */
export const encrypt = (text, keyHex) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Text must be a non-empty string');
  }

  if (!keyHex || keyHex.length !== 64) {
    throw new Error('Key must be a 64-character hex string');
  }

  try {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(IV_LENGTH);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Format: iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
};

/**
 * Decrypt text using AES-256-GCM
 * @param {string} encryptedText - Encrypted data in format: {iv}:{authTag}:{encryptedData}
 * @param {string} keyHex - Encryption key as hex string (64 characters)
 * @returns {string} Decrypted plain text
 */
export const decrypt = (encryptedText, keyHex) => {
  if (!encryptedText || typeof encryptedText !== 'string') {
    throw new Error('Encrypted text must be a non-empty string');
  }

  if (!keyHex || keyHex.length !== 64) {
    throw new Error('Key must be a 64-character hex string');
  }

  try {
    const parts = encryptedText.split(':');
    
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format. Expected: iv:authTag:data');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = Buffer.from(keyHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    if (error.message.includes('Unsupported state')) {
      throw new Error('Decryption failed: Invalid key or tampered data');
    }
    throw new Error(`Decryption failed: ${error.message}`);
  }
};

/**
 * Check if a string appears to be encrypted
 * @param {string} text - Text to check
 * @returns {boolean}
 */
export const isEncrypted = (text) => {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  // Encrypted format: iv:authTag:data (all hex)
  const parts = text.split(':');
  if (parts.length !== 3) {
    return false;
  }

  // Check if all parts are valid hex
  const hexRegex = /^[0-9a-f]+$/i;
  return parts.every(part => hexRegex.test(part));
};

/**
 * Generate a blind index hash for searchable encrypted fields
 * Uses HMAC-SHA256 to create a deterministic hash
 * @param {string} text - Plain text to hash
 * @param {string} keyHex - Organization key (64-character hex)
 * @returns {string} Hash as hex string
 */
export const createBlindIndex = (text, keyHex) => {
  if (!text || typeof text !== 'string') {
    throw new Error('Text must be a non-empty string');
  }

  if (!keyHex || keyHex.length !== 64) {
    throw new Error('Key must be a 64-character hex string');
  }

  const key = Buffer.from(keyHex, 'hex');
  return crypto.createHmac('sha256', key)
    .update(text.toLowerCase().trim()) // Normalize for consistent hashing
    .digest('hex');
};

export default {
  encrypt,
  decrypt,
  isEncrypted,
  createBlindIndex
};
