/**
 * Decrypt board member sensitive fields before sending in API responses.
 * Ensures admins and authorized callers never receive encrypted data.
 *
 * Board member schema encrypted paths (must match boardMemberSchema.js).
 */

import { decrypt, isEncrypted } from './encryption.js';
import { logError } from './logger.js';

const ENCRYPTED_PATHS = [
  'given_names',
  'family_name',
  'date_of_birth',
  'email',
  'phone',
  'residential_address.line1',
  'residential_address.suburb',
  'residential_address.postcode'
];

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o != null && typeof o === 'object' ? o[k] : undefined), obj);
}

function setByPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  if (parts.length === 0) {
    obj[last] = value;
    return;
  }
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const k = parts[i];
    if (!(k in cur) || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}

/**
 * Decrypt a single board member plain object in place.
 * @param {Object} doc - Board member document (plain object or mongoose doc)
 * @param {string} keyHex - Encryption key (64-char hex; app uses master key)
 */
export function decryptBoardMemberFields(doc, keyHex) {
  if (!doc || !keyHex || typeof keyHex !== 'string' || keyHex.length !== 64) {
    return;
  }
  for (const path of ENCRYPTED_PATHS) {
    const value = getByPath(doc, path);
    if (value != null && typeof value === 'string' && isEncrypted(value)) {
      try {
        const decrypted = decrypt(value, keyHex);
        setByPath(doc, path, decrypted);
      } catch (err) {
        logError('Failed to decrypt board member field', err, { path, docId: doc._id });
        setByPath(doc, path, ''); // Never send raw encrypted data to client
      }
    }
  }
}

/**
 * Decrypt an array of board members in place.
 * @param {Array<Object>} list - Array of board member documents
 * @param {string} keyHex - Encryption key (64-char hex)
 */
export function decryptBoardMemberList(list, keyHex) {
  if (!Array.isArray(list)) return;
  list.forEach((doc) => decryptBoardMemberFields(doc, keyHex));
}
