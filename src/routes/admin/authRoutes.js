/**
 * SuperAdmin auth — separate from tenant auth.
 *
 * Lives at /api/v1/admin/auth/* and is the only public-facing route under
 * the /admin namespace. Mints a JWT signed by the same JWT_SECRET as
 * tenant tokens but with no orgId and roles:['calcite.super_admin'], so
 * the existing `authenticate` middleware accepts it cleanly while
 * everything tenant-scoped (orgId checks, position permissions, position
 * transfer block, account-active check) skips it.
 *
 * Account lockout: 5 failed attempts within 15 minutes locks the account
 * for 15 minutes. The lockout is per-account, not per-IP — keeps the data
 * model simple, and brute-force at the IP level should be handled at the
 * edge (Cloudflare / Render rate limits) anyway.
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { body } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authenticate, generateToken } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { logInfo, logError } from '../../utils/logger.js';
import getRouterModels from '../../db/models/routerModels.js';

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// Bootstrap config — first super-admin can be created via API instead of
// CLI when local Atlas access is blocked. Secret-gated and one-shot.
const BCRYPT_ROUNDS = 12;
const PASSWORD_LENGTH = 24;
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' +
  'abcdefghijkmnopqrstuvwxyz' +
  '23456789' +
  '@#%^_+-=:.,';

function generateStrongPassword(length = PASSWORD_LENGTH) {
  const out = [];
  const buf = crypto.randomBytes(length * 2);
  let i = 0;
  while (out.length < length) {
    const byte = buf[i++ % buf.length];
    if (byte < (256 - (256 % PASSWORD_ALPHABET.length))) {
      out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
    }
  }
  return out.join('');
}

/** Constant-time string compare so secret comparison doesn't leak length / position. */
function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * POST /api/v1/admin/auth/bootstrap
 *
 * One-shot endpoint to create the FIRST super-admin via API. Useful when
 * local DB access is blocked (DNS / firewall / SRV resolution failures)
 * but the deployed backend can reach Atlas. Locks itself permanently
 * after the first super-admin exists in the DB.
 *
 * Security model — three layers, all required:
 *   1. SUPERADMIN_BOOTSTRAP_SECRET env var must be set on the server.
 *      Without it the endpoint 503s. Set this only when you're about to
 *      bootstrap; remove it after first use for defence-in-depth.
 *   2. The caller must present that secret in the `x-bootstrap-secret`
 *      header (constant-time comparison).
 *   3. Zero super-admins must currently exist. If any super-admin record
 *      is in the DB, this endpoint 403s permanently.
 *
 * Body: { email, fullName, password? }
 *   - password is optional; if omitted, a 24-char strong password is
 *     generated and returned in the response. Save it immediately — it
 *     is not stored or logged anywhere.
 *
 * Curl example (call against your deployed backend, NOT localhost):
 *   curl -X POST https://api.your-host.com/api/v1/admin/auth/bootstrap \
 *     -H 'Content-Type: application/json' \
 *     -H 'x-bootstrap-secret: <the-env-var-value>' \
 *     -d '{"email":"sohaib@calcite.tech","fullName":"Sohaib Ahmed"}'
 */
router.post(
  '/bootstrap',
  [
    body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
    body('fullName').isString().trim().isLength({ min: 1 }).withMessage('Full name required'),
    body('password').optional().isString().isLength({ min: 16 }).withMessage('Password must be at least 16 characters')
  ],
  validate,
  asyncHandler(async (req, res) => {
    // Layer 1 — env var presence.
    const expectedSecret = process.env.SUPERADMIN_BOOTSTRAP_SECRET || '';
    if (!expectedSecret) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'BOOTSTRAP_DISABLED',
          message: 'Bootstrap is disabled. Set SUPERADMIN_BOOTSTRAP_SECRET on the server to enable.'
        }
      });
    }

    // Layer 2 — secret header.
    const providedSecret = req.headers['x-bootstrap-secret'] || '';
    if (!safeEqual(providedSecret, expectedSecret)) {
      logError('Bootstrap secret mismatch', null, { ip: req.ip });
      return res.status(401).json({
        success: false,
        error: { code: 'BOOTSTRAP_SECRET_INVALID', message: 'Invalid bootstrap secret.' }
      });
    }

    // Layer 3 — no super-admins must exist.
    const { SuperAdmin } = getRouterModels();
    const existingCount = await SuperAdmin.estimatedDocumentCount();
    if (existingCount > 0) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'BOOTSTRAP_LOCKED',
          message: 'Bootstrap is permanently locked — at least one super-admin already exists. Use the standard login or have an existing super-admin invite a new one.'
        }
      });
    }

    const { email, fullName } = req.body;
    const generated = !req.body.password;
    const plaintext = req.body.password || generateStrongPassword();
    const password_hash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);

    const created = await SuperAdmin.create({
      email,
      password_hash,
      full_name: fullName,
      status: 'active'
    });

    logInfo('Bootstrap super-admin created', { email });

    return res.status(201).json({
      success: true,
      data: {
        userId: created._id.toString(),
        email: created.email,
        fullName: created.full_name,
        // Returned ONCE here. Not stored, not logged. Save it now.
        password: plaintext,
        passwordWasGenerated: generated,
        loginUrl: '/calcite-admin/login',
        warning: 'This is the first super-admin. The bootstrap endpoint is now permanently locked. Save the password immediately — there is no recovery flow.'
      }
    });
  })
);

/**
 * POST /api/v1/admin/auth/login
 * { email, password } → { token, user }
 *
 * Constant-time-ish: failed lookups still bcrypt-compare against a dummy
 * hash so timing doesn't leak whether the email exists.
 */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
    body('password').isString().isLength({ min: 1 }).withMessage('Password required')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const { SuperAdmin } = getRouterModels();

    // Pull password_hash explicitly (schema sets `select: false`).
    const admin = await SuperAdmin.findOne({ email }).select('+password_hash');

    // Always run a bcrypt compare so non-existent emails take the same time
    // as wrong passwords. This dummy hash is for "any password no match".
    const DUMMY_HASH = '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789abcdefghijkl.';
    const hashToCompare = admin?.password_hash || DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCompare);

    if (!admin) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
      });
    }

    // Account state checks.
    if (admin.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_DISABLED', message: 'This super-admin account is disabled.' }
      });
    }
    if (admin.locked_until && admin.locked_until > new Date()) {
      const minutes = Math.ceil((admin.locked_until - new Date()) / 60000);
      return res.status(429).json({
        success: false,
        error: {
          code: 'ACCOUNT_LOCKED',
          message: `Too many failed attempts. Try again in ${minutes} minute(s).`
        }
      });
    }

    if (!passwordMatches) {
      const newFailures = (admin.failed_login_attempts || 0) + 1;
      const update = { failed_login_attempts: newFailures };
      if (newFailures >= MAX_FAILED_ATTEMPTS) {
        update.locked_until = new Date(Date.now() + LOCKOUT_MS);
        update.failed_login_attempts = 0;
        logError('SuperAdmin account locked due to failed attempts', null, { email: admin.email });
      }
      await SuperAdmin.updateOne({ _id: admin._id }, { $set: update });
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }
      });
    }

    // Success: reset counters, stamp last login, mint a token.
    await SuperAdmin.updateOne({ _id: admin._id }, {
      $set: {
        last_login_at: new Date(),
        last_login_ip: req.ip || req.headers['x-forwarded-for'] || '',
        failed_login_attempts: 0,
        locked_until: null
      }
    });

    // Map DB role → JWT role name. Existing accounts default to super_admin.
    const dbRole = admin.role || 'super_admin';
    const calciteRole = `calcite.${dbRole}`;

    const token = generateToken({
      userId: admin._id.toString(),
      email: admin.email,
      roles: [calciteRole, dbRole],
      // Intentionally no orgId — Calcite staff don't belong to a tenant.
      // The existing `authenticate` middleware skips every tenant-DB check
      // when orgId is absent, so this token "just works" against /admin/*.
      permissions: []
    });

    logInfo('SuperAdmin login', { email: admin.email, role: dbRole });

    return res.json({
      success: true,
      data: {
        token,
        user: {
          userId: admin._id.toString(),
          email: admin.email,
          fullName: admin.full_name,
          role: dbRole,
          roles: [calciteRole, dbRole]
        }
      }
    });
  })
);

/**
 * GET /api/v1/admin/auth/me
 * Auth-protected echo of the current super-admin session. Used by the
 * frontend route guard to confirm the token is still valid + super-admin.
 */
import { requireCalciteStaff } from '../../middleware/requireSuperAdmin.js';

router.get('/me', authenticate, requireCalciteStaff, (req, res) => {
  // Derive the friendly role name from the JWT roles array.
  const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
  let role = 'super_admin';
  if (roles.includes('calcite.billing_operator') || roles.includes('billing_operator')) role = 'billing_operator';
  else if (roles.includes('calcite.support_agent') || roles.includes('support_agent')) role = 'support_agent';
  res.json({
    success: true,
    data: {
      userId: req.user.userId,
      email: req.user.email,
      role,
      roles: req.user.roles
    }
  });
});

export default router;
