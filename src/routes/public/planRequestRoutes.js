/**
 * Public, UNAUTHENTICATED "Contact support" form submission.
 *
 * The customer hits this from the bespoke / contact-sales tier on the
 * /pricing page (and the /contact-sales page). We:
 *   1. Validate + persist a PlanRequest in the Router DB.
 *   2. Fire a notification email to SUPPORT_EMAIL ("we received a
 *      bespoke plan request").
 *   3. Send the requester an acknowledgement ("we'll get back to you").
 *
 * Both emails are best-effort — we never fail the request because SMTP
 * had a hiccup. Delivery state is stamped onto the row so support can
 * re-trigger from the admin UI.
 *
 * No tenant context, no auth middleware. Mirrors the shape of
 * publicPlansRoutes.js so future "leadgen" endpoints can live alongside.
 */

import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import getRouterModels from '../../db/models/routerModels.js';
import emailService, { buildEmailTemplate } from '../../services/emailService.js';
import { logError, logInfo } from '../../utils/logger.js';

const router = express.Router();

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@stewardex.com';
const APP_NAME = process.env.APP_NAME || 'Stewardex';

/**
 * Map a plan code → display name. Keeps the email subject and body human-
 * readable even when the catalogue has custom codes. Falls back to the
 * code itself if no friendly name is known.
 */
function planLabel(code, fallback = '') {
  const map = {
    foundation: 'Foundation',
    professional: 'Professional',
    enterprise: 'Enterprise',
    bespoke: 'Bespoke'
  };
  return map[String(code || '').toLowerCase()] || fallback || (code ? String(code) : 'Stewardex');
}

router.post(
  '/',
  [
    body('name').isString().trim().isLength({ min: 1, max: 120 }).withMessage('Name is required.'),
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('organization_name').optional({ checkFalsy: true }).isString().trim().isLength({ max: 160 }),
    body('phone').optional({ checkFalsy: true }).isString().trim().isLength({ max: 60 }),
    body('plan_code').optional({ checkFalsy: true }).isString().trim().isLength({ max: 64 }),
    body('plan_name').optional({ checkFalsy: true }).isString().trim().isLength({ max: 120 }),
    body('message').optional({ checkFalsy: true }).isString().trim().isLength({ max: 4000 }),
    body('source_url').optional({ checkFalsy: true }).isString().trim().isLength({ max: 500 }),
    body('org_id').optional({ checkFalsy: true }).isString().trim().isLength({ max: 64 })
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { PlanRequest } = getRouterModels();
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const orgName = String(req.body.organization_name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const planCode = String(req.body.plan_code || 'bespoke').toLowerCase().trim();
    const planName = String(req.body.plan_name || '').trim() || planLabel(planCode);
    const message = String(req.body.message || '').trim();
    const sourceUrl = String(req.body.source_url || '').trim();
    const existingOrgId = String(req.body.org_id || '').trim().toLowerCase();

    // Persist FIRST so a downstream email failure doesn't lose the lead.
    const created = await PlanRequest.create({
      name,
      email,
      phone,
      organization_name: orgName,
      plan_code: planCode,
      plan_name: planName,
      message,
      status: 'new',
      source_url: sourceUrl,
      existing_org_id: existingOrgId,
      source_ip: req.ip || '',
      user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
      captured_at: new Date()
    });

    // Fire both emails in parallel. Capture per-recipient success so the
    // admin UI can show which channel needs a retry. We never propagate
    // a send error to the caller — the row exists either way.
    const sendOwnerEmail = async () => {
      const subject = `[${APP_NAME}] New ${planLabel(planCode)} plan request — ${orgName || name}`;
      const messageHtml = message
        ? `<p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; text-align: left;"><strong>Their message:</strong></p><p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; text-align: left; white-space: pre-wrap;">${escapeHtml(message)}</p>`
        : '<p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #666; text-align: left; font-style: italic;">No message left.</p>';
      const html = buildEmailTemplate({
        heading: `We received a ${planLabel(planCode)} plan request`,
        headingHighlight: planLabel(planCode),
        bodyHtml: `
          <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; text-align: left;">
            A prospect just submitted a contact-sales enquiry on the pricing page.
            Triage it from the Calcite admin portal — the request is open under
            <strong>Plan requests</strong>.
          </p>
          ${messageHtml}
        `,
        buttonText: 'Open in admin portal',
        buttonLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/calcite-admin/plan-requests`,
        infoBoxLines: [
          `Name: ${name}`,
          `Email: ${email}`,
          orgName ? `Organisation: ${orgName}` : null,
          phone ? `Phone: ${phone}` : null,
          existingOrgId ? `Existing tenant: ${existingOrgId}` : null,
          `Plan looked at: ${planLabel(planCode, planName)}`,
          sourceUrl ? `Source: ${sourceUrl}` : null,
          `Captured: ${new Date().toLocaleString('en-AU')}`
        ].filter(Boolean)
      });
      await emailService.sendEmail({ to: SUPPORT_EMAIL, subject, html });
    };

    const sendAckEmail = async () => {
      const subject = `Thanks for getting in touch — ${APP_NAME}`;
      const html = buildEmailTemplate({
        heading: `Thanks, ${name.split(' ')[0] || 'there'} — we'll be in touch`,
        headingHighlight: 'Thanks',
        bodyHtml: `
          <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; text-align: center; max-width: 500px;">
            We've received your enquiry about the <strong>${planLabel(planCode, planName)}</strong> plan and a member of our team will get back to you shortly — usually within one business day.
          </p>
          <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; text-align: center; max-width: 500px;">
            In the meantime, feel free to reply to this email with anything else you'd like us to know about your organisation or what you're hoping to achieve with ${APP_NAME}.
          </p>
        `,
        infoBoxLines: [
          'Your reference: ' + String(created._id).slice(-8).toUpperCase(),
          'Need us sooner? Reply to this email and we\'ll prioritise.'
        ]
      });
      await emailService.sendEmail({ to: email, subject, html });
    };

    const [ownerResult, ackResult] = await Promise.allSettled([sendOwnerEmail(), sendAckEmail()]);

    const update = {};
    if (ownerResult.status === 'fulfilled') update.owner_email_sent_at = new Date();
    if (ackResult.status === 'fulfilled') update.ack_email_sent_at = new Date();
    const errors = [];
    if (ownerResult.status === 'rejected') errors.push(`owner: ${ownerResult.reason?.message || ownerResult.reason}`);
    if (ackResult.status === 'rejected') errors.push(`ack: ${ackResult.reason?.message || ackResult.reason}`);
    if (errors.length) {
      update.email_send_error = errors.join(' | ').slice(0, 500);
      logError('Plan request email delivery failed', { requestId: created._id, errors });
    } else {
      logInfo('Plan request submitted', { requestId: created._id, plan: planCode, email });
    }
    if (Object.keys(update).length) {
      await PlanRequest.updateOne({ _id: created._id }, { $set: update });
    }

    res.status(201).json({
      success: true,
      data: {
        id: String(created._id),
        message: 'Thanks — your enquiry has been received. We\'ll be in touch within one business day.',
        notified_owner: ownerResult.status === 'fulfilled',
        ack_sent: ackResult.status === 'fulfilled'
      }
    });
  })
);

/**
 * Minimal HTML entity escaping for safe interpolation into the email
 * template. We don't trust the prospect's message body.
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default router;
