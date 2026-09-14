/**
 * API-key gate for server-to-server integrations (e.g. the Calcite Hyper
 * system). Mounted on /api/v1/integration/* only — tenant and SuperAdmin
 * routes keep their JWT auth untouched.
 *
 * Keys come from INTEGRATION_API_KEYS, a comma-separated list of
 * `name:key` pairs (the name is optional and only used for audit):
 *   INTEGRATION_API_KEYS=hyper:stx_live_abc...,backup:stx_live_def...
 *
 * Callers send the key in the `x-api-key` header. Comparison is done on
 * SHA-256 digests with timingSafeEqual so neither length nor content leaks.
 */

import crypto from 'crypto';
import { logWarn } from '../utils/logger.js';

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

function loadKeys() {
  return String(process.env.INTEGRATION_API_KEYS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      const name = idx > 0 ? entry.slice(0, idx).trim() : 'integration';
      const key = idx > 0 ? entry.slice(idx + 1).trim() : entry;
      return { name, hash: digest(key) };
    })
    .filter((k) => k.hash.length);
}

const KEYS = loadKeys();

export const requireApiKey = (req, res, next) => {
  if (KEYS.length === 0) {
    return res.status(503).json({
      success: false,
      error: { code: 'INTEGRATION_DISABLED', message: 'Integration API is not configured on this server.' }
    });
  }

  const provided = req.headers['x-api-key'];
  if (!provided) {
    return res.status(401).json({
      success: false,
      error: { code: 'API_KEY_REQUIRED', message: 'Missing x-api-key header.' }
    });
  }

  const providedHash = digest(provided);
  const match = KEYS.find((k) => crypto.timingSafeEqual(k.hash, providedHash));
  if (!match) {
    logWarn('Integration API key rejected', { ip: req.ip, path: req.path });
    return res.status(401).json({
      success: false,
      error: { code: 'API_KEY_INVALID', message: 'Invalid API key.' }
    });
  }

  // Synthetic service identity. userId stays null because audit fields
  // (actor_id, updated_by, …) are ObjectIds; the email carries the key name.
  req.integration = { name: match.name };
  req.user = {
    userId: null,
    email: `integration:${match.name}`,
    roles: ['integration'],
    permissions: [],
    isAuditor: false
  };
  next();
};

export default requireApiKey;
