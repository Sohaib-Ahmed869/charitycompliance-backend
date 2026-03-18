import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler.js';

const REQUIRED_BYTES = 32;

function getKey() {
  const raw = process.env.ASSET_CREDENTIALS_KEY;
  if (!raw) {
    throw new AppError('ASSET_CREDENTIALS_KEY is not configured', 500, 'ENCRYPTION_KEY_MISSING');
  }
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== REQUIRED_BYTES) {
    throw new AppError('ASSET_CREDENTIALS_KEY must be 32 bytes hex', 500, 'ENCRYPTION_KEY_INVALID');
  }
  return buf;
}

export function encryptSecret(plaintext) {
  if (!plaintext) {
    return { algorithm: 'aes-256-gcm', iv: null, auth_tag: null, cipher_text: null };
  }
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('hex'),
    auth_tag: tag.toString('hex'),
    cipher_text: enc.toString('hex')
  };
}

export function decryptSecret(payload) {
  if (!payload || !payload.cipher_text || !payload.iv || !payload.auth_tag) return '';
  const key = getKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.auth_tag, 'hex');
  const enc = Buffer.from(payload.cipher_text, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

