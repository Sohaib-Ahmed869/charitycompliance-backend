/**
 * Configuration Module
 * 
 * Centralized configuration management.
 * Reads all environment variables and groups them logically.
 * Fails fast on missing required variables at startup.
 */

import dotenv from 'dotenv';

dotenv.config();

// Server Configuration
export const server = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT) || 5000,
  corsOrigin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
  // Where Stripe redirects the browser back to after a Checkout success
  // / cancel — must be the frontend URL, never the backend's. Prefer an
  // explicit FRONTEND_URL env var; fall back to the first CORS origin
  // (which is always the FE in dev); finally default to localhost:5173.
  frontendUrl:
    process.env.FRONTEND_URL?.replace(/\/+$/, '') ||
    process.env.CORS_ORIGIN?.split(',')[0]?.trim()?.replace(/\/+$/, '') ||
    'http://localhost:5173'
};

// Database Configuration
export const db = {
  routerUri: process.env.ROUTER_DB_URI,
  maxPoolSize: parseInt(process.env.MAX_POOL_SIZE) || 10,
  minPoolSize: parseInt(process.env.MIN_POOL_SIZE) || 0,
  connectionIdleTimeout: parseInt(process.env.CONNECTION_IDLE_TIMEOUT_MS) || 600000,
  tenantCacheTtl: parseInt(process.env.TENANT_CACHE_TTL) || 3600
};

// Encryption Configuration (trim to avoid .env newline breaking decryption)
export const encryption = {
  masterKeyHex: (process.env.MASTER_KEY_HEX || '').trim()
};

// Authentication Configuration
export const auth = {
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  mfaEnabledByDefault: process.env.MFA_ENABLED_BY_DEFAULT === 'true',
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 60
};

// Stripe Configuration
export const stripe = {
  secretKey: process.env.STRIPE_SECRET_KEY,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
};

// File Upload Configuration
export const upload = {
  path: process.env.UPLOAD_PATH || './uploads',
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760,
  allowedFileTypes: process.env.ALLOWED_FILE_TYPES?.split(',') || ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png']
};

// Rate Limiting Configuration
export const rateLimit = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
};

// Logging Configuration
export const logging = {
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG'),
  logFile: process.env.LOG_FILE || './logs/app.log'
};

// Feature Flags
export const features = {
  marketplace: process.env.ENABLE_MARKETPLACE !== 'false',
  integrations: process.env.ENABLE_INTEGRATIONS !== 'false',
  auditLogging: process.env.ENABLE_AUDIT_LOGGING !== 'false',
  notifications: process.env.ENABLE_NOTIFICATIONS !== 'false'
};

// Web Push (browser notifications) — OPTIONAL. When the VAPID keys are
// unset, push is simply disabled and the app still boots normally; it is
// deliberately not in requiredVars. Generate keys with:
//   node -e "console.log(require('web-push').generateVAPIDKeys())"
export const webPush = {
  vapidPublicKey: (process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim(),
  vapidPrivateKey: (process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim(),
  vapidSubject: (process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:notifications@stewardex.com').trim()
};

// Password Requirements
export const password = {
  minLength: parseInt(process.env.MIN_PASSWORD_LENGTH) || 8,
  requireUppercase: process.env.REQUIRE_UPPERCASE !== 'false',
  requireLowercase: process.env.REQUIRE_LOWERCASE !== 'false',
  requireNumbers: process.env.REQUIRE_NUMBERS !== 'false',
  requireSpecialChars: process.env.REQUIRE_SPECIAL_CHARS !== 'false'
};

// Validation: Check required environment variables
const requiredVars = [
  { key: 'ROUTER_DB_URI', value: db.routerUri },
  { key: 'MASTER_KEY_HEX', value: encryption.masterKeyHex },
  { key: 'JWT_SECRET', value: auth.jwtSecret }
];

const missingVars = requiredVars.filter(({ value }) => !value);

if (missingVars.length > 0) {
  const missing = missingVars.map(({ key }) => key).join(', ');
  throw new Error(`Missing required environment variables: ${missing}`);
}

// Validate Master Key format
if (encryption.masterKeyHex && encryption.masterKeyHex.length !== 64) {
  throw new Error('MASTER_KEY_HEX must be exactly 64 characters (32 bytes in hex)');
}

export default {
  server,
  db,
  encryption,
  auth,
  stripe,
  upload,
  rateLimit,
  logging,
  features,
  webPush,
  password
};
