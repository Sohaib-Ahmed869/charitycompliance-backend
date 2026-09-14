/**
 * SuperAdmin staff management — CRUD for billing operators + support
 * agents. Only super_admin can manage staff (the role-CRUD itself is a
 * super-admin-only operation).
 *
 * The bootstrap super-admin can create both other super-admins and
 * specialised staff (billing_operator, support_agent). On creation a
 * strong random password is generated, returned ONCE in the response.
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { body, param } from 'express-validator';
import { authenticate } from '../../middleware/auth.js';
import { requireSuperAdmin } from '../../middleware/requireSuperAdmin.js';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import { writeBillingEvent } from '../../utils/writeBillingEvent.js';
import emailService, { buildEmailTemplate } from '../../services/emailService.js';

const router = express.Router();
router.use(authenticate);
// NOTE: requireSuperAdmin is applied per-route below, NOT via router.use().
// All admin sub-routers share the same /api/v1/admin mount prefix, so a
// router-level requireSuperAdmin would also run for non-matching paths
// like /admin/tickets — it would 403 a support_agent on a route that
// belongs to adminTicketsRoutes. Per-route guards make sure the gate
// only fires when the request actually targets a /staff endpoint.

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

const ROLE_NAMES = {
  super_admin: 'Super Admin',
  billing_operator: 'Billing Operator',
  support_agent: 'Support Agent'
};

const ROLE_DESCRIPTIONS = {
  super_admin:      'Full access — plans, billing, tickets, audit, staff.',
  billing_operator: 'Customer billing operations — invoices, payments, refunds, coupons.',
  support_agent:    'Help-centre tickets and the bug + feature kanban boards.'
};

/**
 * Send the staff member their login credentials. Fire-and-forget — failure
 * logs and never throws. The plaintext password is delivered exactly once.
 */
async function sendStaffInviteEmail({ to, fullName, role, password, isReset = false }) {
  if (!to || !password) return;
  const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  const loginUrl = `${baseUrl}/calcite-admin/login`;
  const roleName = ROLE_NAMES[role] || role;
  const roleDesc = ROLE_DESCRIPTIONS[role] || '';

  const heading = isReset ? 'Your password has been reset' : `You're invited as ${roleName}`;
  const intro = isReset
    ? `<p style="margin: 0 0 14px 0; font-size: 13.5px; line-height: 1.6; color: #334155; text-align: center;">A Calcite super-admin has reset your password. Use the new credentials below to sign in.</p>`
    : `<p style="margin: 0 0 14px 0; font-size: 13.5px; line-height: 1.6; color: #334155; text-align: center;">Hi ${fullName || 'there'},</p>
       <p style="margin: 0 0 14px 0; font-size: 13.5px; line-height: 1.6; color: #334155; text-align: center;">You've been added as a <strong>${roleName}</strong> on the Calcite portal.</p>
       ${roleDesc ? `<p style="margin: 0 0 14px 0; font-size: 12.5px; line-height: 1.6; color: #475569; text-align: center; max-width: 500px; margin-inline: auto;">${roleDesc}</p>` : ''}
       <p style="margin: 0 0 14px 0; font-size: 13.5px; line-height: 1.6; color: #334155; text-align: center;">Sign in with the credentials below. We strongly recommend rotating this password from your account once you're in.</p>`;

  const html = buildEmailTemplate({
    heading,
    headingHighlight: isReset ? 'Your' : "You're",
    bodyHtml: `
      ${intro}
      <table cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 460px; margin: 0 auto; background: #f8fafc; border-radius: 12px; padding: 18px 20px;">
        <tr>
          <td style="padding-bottom: 10px;">
            <div style="font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 4px;">Email</div>
            <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; color: #0a2540; font-weight: 600;">${to}</div>
          </td>
        </tr>
        <tr>
          <td>
            <div style="font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 4px;">Temporary password</div>
            <div style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 15px; color: #0a2540; font-weight: 700; word-break: break-all; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">${password}</div>
          </td>
        </tr>
      </table>
    `,
    buttonText: 'Sign in to Calcite Portal',
    buttonLink: loginUrl,
    infoBoxLines: [
      `Login URL: ${loginUrl}`,
      'Save this password now — it cannot be viewed again.',
      "If you didn't expect this email, contact your Calcite super admin."
    ]
  });

  try {
    await emailService.sendEmail({
      to,
      subject: isReset ? 'Your Calcite portal password has been reset' : `You're invited to the Calcite portal as ${roleName}`,
      html
    });
  } catch (err) {
    console.error('[staffRoutes] failed to send staff email to', to, err?.message || err);
  }
}

function serialize(s) {
  return {
    _id: s._id,
    email: s.email,
    full_name: s.full_name,
    role: s.role || 'super_admin',
    status: s.status,
    last_login_at: s.last_login_at,
    created_at: s.created_at,
    created_by: s.created_by
  };
}

/** GET /admin/staff — list every Calcite staff member. */
router.get('/staff', requireSuperAdmin, asyncHandler(async (_req, res) => {
  const { SuperAdmin } = getRouterModels();
  const staff = await SuperAdmin.find({}).sort({ created_at: -1 }).lean();
  res.json({ success: true, data: staff.map(serialize) });
}));

/**
 * POST /admin/staff — create a new staff member with the given role.
 * Returns the generated password ONCE.
 */
router.post(
  '/staff',
  requireSuperAdmin,
  [
    body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
    body('fullName').isString().trim().isLength({ min: 1, max: 80 }).withMessage('Full name required'),
    body('role').isIn(['super_admin', 'billing_operator', 'support_agent']).withMessage('Invalid role')
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SuperAdmin } = getRouterModels();
    const exists = await SuperAdmin.findOne({ email: req.body.email });
    if (exists) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'A staff account with that email already exists.' }
      });
    }
    const password = generateStrongPassword();
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const created = await SuperAdmin.create({
      email: req.body.email,
      password_hash,
      full_name: req.body.fullName,
      role: req.body.role,
      status: 'active',
      created_by: req.user?.userId || null
    });
    await writeBillingEvent(req, {
      action: 'super_admin.created',
      targetType: 'super_admin',
      targetId: String(created._id),
      targetLabel: created.email,
      reason: `Created ${req.body.role} account`,
      metadata: { role: req.body.role }
    });

    // Fire-and-forget: invite email with credentials + login URL.
    sendStaffInviteEmail({
      to: created.email,
      fullName: created.full_name,
      role: created.role,
      password,
      isReset: false
    });

    res.status(201).json({
      success: true,
      data: {
        ...serialize(created.toObject()),
        password,
        emailSent: true,
        passwordWarning: 'Sent by email AND shown once here. The operator can sign in immediately.'
      }
    });
  })
);

/**
 * PATCH /admin/staff/:id — update staff name / role / status.
 * Cannot demote yourself (would lock the org out of the SuperAdmin portal).
 */
router.patch(
  '/staff/:id',
  requireSuperAdmin,
  [
    param('id').isMongoId(),
    body('fullName').optional().isString().trim().isLength({ min: 1, max: 80 }),
    body('role').optional().isIn(['super_admin', 'billing_operator', 'support_agent']),
    body('status').optional().isIn(['active', 'disabled'])
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { SuperAdmin } = getRouterModels();
    if (String(req.user?.userId) === String(req.params.id) && req.body.role && req.body.role !== 'super_admin') {
      return res.status(400).json({
        success: false,
        error: { code: 'CANNOT_DEMOTE_SELF', message: 'You cannot demote your own account.' }
      });
    }
    if (String(req.user?.userId) === String(req.params.id) && req.body.status === 'disabled') {
      return res.status(400).json({
        success: false,
        error: { code: 'CANNOT_DISABLE_SELF', message: 'You cannot disable your own account.' }
      });
    }
    const updates = {};
    if (req.body.fullName) updates.full_name = req.body.fullName;
    if (req.body.role) updates.role = req.body.role;
    if (req.body.status) updates.status = req.body.status;
    const before = await SuperAdmin.findById(req.params.id).lean();
    if (!before) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff not found.' } });
    }
    const updated = await SuperAdmin.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true }).lean();
    res.json({ success: true, data: serialize(updated) });
  })
);

/**
 * POST /admin/staff/:id/reset-password — generate + return a new password.
 */
router.post(
  '/staff/:id/reset-password',
  requireSuperAdmin,
  [param('id').isMongoId()],
  validate,
  asyncHandler(async (req, res) => {
    const { SuperAdmin } = getRouterModels();
    const target = await SuperAdmin.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff not found.' } });
    }
    const password = generateStrongPassword();
    target.password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    target.failed_login_attempts = 0;
    target.locked_until = null;
    await target.save();
    await writeBillingEvent(req, {
      action: 'super_admin.password_rotated',
      targetType: 'super_admin',
      targetId: String(target._id),
      targetLabel: target.email
    });

    sendStaffInviteEmail({
      to: target.email,
      fullName: target.full_name,
      role: target.role,
      password,
      isReset: true
    });

    res.json({
      success: true,
      data: {
        password,
        emailSent: true,
        passwordWarning: 'Sent by email AND shown once here.'
      }
    });
  })
);

export default router;
