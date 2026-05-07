/**
 * Email Service
 *
 * Handles sending emails using nodemailer with SMTP. Templates follow the
 * Stewardex brand system: deep-navy → azure → teal gradient (sampled from
 * the Stewardex wordmark), logoFull image when available, gradient CTA
 * button, and a clean light card on a neutral backdrop. Single template
 * function `buildEmailTemplate` is the source of truth for every email
 * the platform sends — change the look here, every email follows.
 */

import nodemailer from 'nodemailer';
import { logError, logInfo } from '../utils/logger.js';

const APP_NAME = process.env.APP_NAME || 'Stewardex';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@stewardex.com';

/**
 * Sentinel embedded in every email built via `buildEmailTemplate`. The
 * `sendEmail` guard checks for this — anything missing it gets auto-wrapped
 * so legacy services that pass raw HTML still ship with the new look.
 */
const BRAND_TEMPLATE_SENTINEL = 'sx-brand-tpl-v1';

/** True when the html string looks like a complete `<html>...</html>` document. */
function looksLikeFullDocument(html) {
  return /^\s*<!doctype/i.test(html) || /<html[\s>]/i.test(html);
}

/** Pull the inner body of a full HTML document so we can wrap just the content. */
function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

// Resolve at call time, not module-load time — dotenv may not have run yet
// when this module is first imported. Accept LOGO_URL (preferred) and the
// legacy lowercase `logo` key for backwards compatibility.
function resolveLogoUrl() {
  const raw = (process.env.LOGO_URL || process.env.logo || '').trim();
  if (!raw) return '';
  // HTML-attribute-safe: pre-signed URLs contain unencoded `&` that some
  // strict email clients treat as entity references. Escape only the
  // characters that matter inside a double-quoted attribute.
  return raw
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

// Brand stops sampled from logoFull.png — same paint as every primary CTA
// in the app. 95deg = horizontal left-to-right (matches the wordmark).
const BRAND_GRADIENT = 'linear-gradient(95deg, #0A2E3F 0%, #117A8B 50%, #4DB3A8 100%)';
const BRAND_DEEP = '#0A2E3F';
const BRAND_AZURE = '#117A8B';
const BRAND_TEAL = '#4DB3A8';
const BODY_BG = '#f4f7fa';                // neutral page surround
const CONTAINER_BG = '#ffffff';            // crisp white card

/**
 * Build base email HTML — brand-aligned design.
 * Top brand-gradient strip, logo lockup, big heading, optional gradient CTA,
 * optional info box, footer with brand-azure links.
 *
 * @param {Object} options
 * @param {string} options.heading                — main heading (e.g. "Reset Your Password")
 * @param {string} [options.headingHighlight]     — optional first word painted in brand-azure
 * @param {string} options.bodyHtml               — main body content (HTML)
 * @param {string} options.buttonText             — CTA button text
 * @param {string} options.buttonLink             — CTA button href
 * @param {string[]} options.infoBoxLines         — info box lines (array of strings)
 * @param {string} [options.rsvpButtonsHtml]      — optional RSVP Accept/Decline buttons HTML
 */
function buildEmailTemplate({ heading, headingHighlight, bodyHtml, buttonText, buttonLink, infoBoxLines, rsvpButtonsHtml }) {
  // Logo: image when LOGO_URL is set (production CDN of logoFull.png), else
  // a brand-gradient wordmark fallback so the email still feels on-brand.
  // HTML width/height attributes are required (Outlook ignores inline styles
  // on <img>, and the Gmail proxy collapses images without an explicit width
  // into a tiny broken-icon).
  const logoUrl = resolveLogoUrl();
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${APP_NAME}" width="180" height="44" border="0" style="width: 180px; height: 44px; max-width: 180px; display: block; margin: 0 auto; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic;" />`
    : `<span style="font-family: 'Bodoni Moda', Georgia, 'Times New Roman', serif; font-size: 30px; font-weight: 700; letter-spacing: -0.015em; color: ${BRAND_DEEP};">${APP_NAME}</span>`;

  // Heading — first word can be painted brand-azure for visual emphasis.
  const headingHtml = headingHighlight
    ? `<span style="color: ${BRAND_AZURE}; font-weight: 700;">${headingHighlight}</span> <span style="color: ${BRAND_DEEP}; font-weight: 700;">${heading.slice(headingHighlight.length).trim()}</span>`
    : `<span style="color: ${BRAND_DEEP};">${heading}</span>`;

  const infoBoxContent = infoBoxLines && infoBoxLines.length
    ? infoBoxLines.map((line, i) => `<p style="margin: ${i === 0 ? '0 0 4px 0' : '0'}; font-size: 12px; line-height: 15px; color: #4A5568; font-weight: 400;">${line}</p>`).join('')
    : '';

  // Brand mark at the front of the info box — small gradient tile with a
  // shield icon. Clear visual link to the brand without relying on emoji.
  const infoIcon = `<span style="display: inline-block; width: 28px; height: 28px; line-height: 28px; border-radius: 8px; background: ${BRAND_GRADIENT}; color: #ffffff; text-align: center; font-size: 14px; font-weight: 700;">🔒</span>`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${APP_NAME} - ${heading}</title>
    <!-- ${BRAND_TEMPLATE_SENTINEL} -->
</head>
<body style="margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: ${BODY_BG};">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${BODY_BG}; min-height: 100vh;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background: ${CONTAINER_BG}; border-radius: 16px; box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 18px 44px -14px rgba(10, 46, 63, 0.18); overflow: hidden;">
                    <!-- Brand-gradient top strip -->
                    <tr>
                        <td style="background: ${BRAND_GRADIENT}; height: 6px; font-size: 0; line-height: 0;">&nbsp;</td>
                    </tr>
                    <tr>
                        <td style="padding: 48px 40px 56px 40px;">
                            <!-- Logo lockup -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 6px;">
                                        ${logoHtml}
                                    </td>
                                </tr>
                                <tr>
                                    <td align="center" style="padding-bottom: 40px;">
                                        <p style="margin: 0; font-size: 11px; line-height: 14px; color: #64748b; font-weight: 600; letter-spacing: 0.10em; text-transform: uppercase;">Your Compliance Suite</p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Heading -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 24px;">
                                        <h1 style="margin: 0; font-family: 'Bodoni Moda', Georgia, 'Times New Roman', serif; font-size: 32px; line-height: 1.15; font-weight: 700; letter-spacing: -0.018em; text-align: center;">${headingHtml}</h1>
                                    </td>
                                </tr>
                            </table>

                            <!-- Body -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding: 0 24px 32px; font-size: 14px; line-height: 1.6; color: #475569;">
                                        ${bodyHtml}
                                    </td>
                                </tr>
                            </table>

                            <!-- CTA Button — brand gradient, brand-tinted shadow -->
                            ${(buttonText && buttonLink) ? `
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 36px;">
                                        <table cellpadding="0" cellspacing="0" border="0" align="center">
                                            <tr>
                                                <td align="center" style="background: ${BRAND_GRADIENT}; border-radius: 999px; box-shadow: 0 1px 2px rgba(10, 46, 63, 0.22), 0 8px 22px -8px rgba(10, 46, 63, 0.45);">
                                                    <a href="${buttonLink}" style="display: inline-block; padding: 14px 32px; text-decoration: none; color: #FFFFFF; font-size: 14px; font-weight: 700; letter-spacing: 0.005em; border-radius: 999px;">
                                                        ${buttonText} →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            ` : ''}
                            ${rsvpButtonsHtml || ''}

                            <!-- Info Box — brand-azure rim, gradient icon tile -->
                            ${infoBoxContent ? `
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding: 0 24px 32px;">
                                        <table cellpadding="0" cellspacing="0" border="0" align="center" style="max-width: 460px; border: 1px solid rgba(17, 122, 139, 0.18); border-radius: 12px; background: rgba(17, 122, 139, 0.04);">
                                            <tr>
                                                <td style="padding: 16px 20px;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40" valign="top" style="padding-right: 12px;">${infoIcon}</td>
                                                            <td valign="middle">
                                                                ${infoBoxContent}
                                                            </td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            ` : ''}

                            <!-- Footer -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="border-top: 1px solid #E5E7EB; padding-top: 28px;">
                                        <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 18px; color: #94a3b8; font-weight: 400;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
                                        <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 18px; color: #94a3b8; font-weight: 400;">
                                            Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color: ${BRAND_AZURE}; text-decoration: none; font-weight: 600;">${SUPPORT_EMAIL}</a>
                                        </p>
                                        <p style="margin: 0; font-size: 12px; line-height: 18px; font-weight: 400;">
                                            <a href="#" style="color: ${BRAND_AZURE}; text-decoration: none; font-weight: 600;">Privacy Policy</a>
                                            <span style="color: #cbd5e1;"> • </span>
                                            <a href="#" style="color: ${BRAND_AZURE}; text-decoration: none; font-weight: 600;">Terms</a>
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`;
}

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
    this.initFailed = false;
    this.lastInitAttempt = null;
  }

  /**
   * Check if SMTP is configured
   */
  isConfigured() {
    const hasHost = !!process.env.SMTP_HOST;
    const hasUser = !!process.env.EMAIL_USER;
    const hasPass = !!process.env.EMAIL_PASS;
    if (!hasHost) logError('SMTP config missing: SMTP_HOST');
    if (!hasUser) logError('SMTP config missing: EMAIL_USER');
    if (!hasPass) logError('SMTP config missing: EMAIL_PASS');
    return hasHost && hasUser && hasPass;
  }

  /**
   * Initialize the email transporter
   */
  async initialize() {
    if (this.initialized) return;

    // Check if SMTP is configured
    if (!this.isConfigured()) {
      logError('Email service not configured - check SMTP_HOST, EMAIL_USER, EMAIL_PASS');
      this.initFailed = true;
      return;
    }

    // Avoid re-attempting init too frequently after failure (wait 5 minutes)
    if (this.initFailed && this.lastInitAttempt) {
      const timeSinceLastAttempt = Date.now() - this.lastInitAttempt;
      if (timeSinceLastAttempt < 5 * 60 * 1000) {
        return; // Skip re-init, still in cooldown
      }
    }

    this.lastInitAttempt = Date.now();

    try {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 10000, // 10s - don't hang on bad SMTP config
        greetingTimeout: 10000
      });

      // Verify connection — but don't block init on it.
      // Gmail SMTP can be slow on cold connects; verify() is optional.
      try {
        await Promise.race([
          this.transporter.verify(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP verify timeout')), 10000))
        ]);
        logInfo('Email service SMTP verify succeeded');
      } catch (verifyErr) {
        logInfo('Email service SMTP verify failed (non-fatal, will attempt sends anyway)', { error: verifyErr.message });
      }

      this.initialized = true;
      this.initFailed = false;
      logInfo('Email service initialized successfully');
    } catch (error) {
      logError('Failed to initialize email service', error);
      this.initFailed = true;
      throw error;
    }
  }

  /**
   * Send an email
   * @param {Object} options - Email options
   * @param {string} options.to - Recipient email
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML content
   * @param {string} options.text - Plain text content (optional)
   */
  async sendEmail({ to, subject, html, text, brandTemplate }) {
    // Belt-and-braces: if `html` wasn't built via `buildEmailTemplate` (no
    // sentinel), wrap it now so every outbound email lands in the brand chrome
    // — gradient strip, logo, footer. Callers can opt out by passing
    // `brandTemplate: false` (e.g. for raw test pings) but that's the only
    // escape hatch.
    if (html && brandTemplate !== false && !html.includes(BRAND_TEMPLATE_SENTINEL)) {
      html = buildEmailTemplate({
        heading: subject || `${APP_NAME} notification`,
        bodyHtml: looksLikeFullDocument(html) ? extractBody(html) : html
      });
    }

    // Check if email service is configured
    if (!this.isConfigured()) {
      logInfo('Email skipped - SMTP not configured', { to, subject });
      return { skipped: true, reason: 'SMTP not configured' };
    }

    if (!this.initialized) {
      try {
        await this.initialize();
      } catch (initError) {
        logError('Email skipped - initialization failed', initError, { to, subject });
        logError('SMTP config at failure', {
          SMTP_HOST: process.env.SMTP_HOST,
          SMTP_PORT: process.env.SMTP_PORT,
          EMAIL_USER: process.env.EMAIL_USER,
          EMAIL_PASS: process.env.EMAIL_PASS ? '***' : undefined
        });
        return { skipped: true, reason: 'SMTP initialization failed' };
      }
    }

    // If still not initialized after attempt (config missing, cooldown, etc.)
    if (!this.initialized) {
      logError('Email skipped - service not available', { to, subject });
      logError('SMTP config at unavailable', {
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        EMAIL_USER: process.env.EMAIL_USER,
        EMAIL_PASS: process.env.EMAIL_PASS ? '***' : undefined
      });
      return { skipped: true, reason: 'Email service not available' };
    }

    try {
      const mailOptions = {
        from: `"${process.env.EMAIL_FROM_NAME || 'Charity Compliance'}" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for text version
      };

      const sendTimeout = parseInt(process.env.SMTP_SEND_TIMEOUT_MS) || 30000;
      const result = await Promise.race([
        this.transporter.sendMail(mailOptions),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`SMTP send timeout (${sendTimeout / 1000}s)`)), sendTimeout))
      ]);
      logInfo('Email sent successfully', { to, subject, messageId: result.messageId });
      return result;
    } catch (error) {
      logError('Failed to send email', error, { to, subject });
      throw error;
    }
  }

  /**
   * Send board member invitation email
   * @param {Object} params - Invitation parameters
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's full name
   * @param {string} params.organizationName - Organization name
   * @param {string} params.position - Position/role title
   * @param {string} params.invitationToken - Unique invitation token
   * @param {string} params.inviterName - Name of person who sent the invite
   */
  async sendBoardMemberInvitation({ to, recipientName, organizationName, position, invitationToken, inviterName, volunteerActionLinks = null }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const isVolunteer = !!volunteerActionLinks;
    const inviteLink = isVolunteer ? null : `${baseUrl}/invitation/${invitationToken}`;

    const subject = isVolunteer
      ? `Welcome as a volunteer at ${organizationName}`
      : `You've been invited to join ${organizationName}`;

    const volunteerLinksHtml = isVolunteer
      ? `
      <div style="margin-top: 16px; text-align: left; max-width: 500px; margin-left: auto; margin-right: auto; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px; padding: 12px;">
        <p style="margin: 0 0 8px 0; font-size: 12px; color: #0F172A; font-weight: 600;">Volunteer quick actions</p>
        <p style="margin: 0 0 6px 0; font-size: 12px;"><a href="${volunteerActionLinks.complaint}" style="color: #2563EB; text-decoration: none;">Submit a complaint</a></p>
        <p style="margin: 0 0 6px 0; font-size: 12px;"><a href="${volunteerActionLinks.risk}" style="color: #2563EB; text-decoration: none;">Submit a risk</a></p>
        <p style="margin: 0; font-size: 12px;"><a href="${volunteerActionLinks.coi}" style="color: #2563EB; text-decoration: none;">Declare conflict of interest (COI)</a></p>
      </div>`
      : '';

    const roleText = position
      ? `as a <strong>${position}</strong>`
      : `as a <strong>volunteer</strong>`;

    const bodyHtml = isVolunteer
      ? `
        <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName},</p>
        <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">${inviterName ? `${inviterName} has added you` : 'You have been added'} to <strong>${organizationName}</strong> ${roleText}.</p>
        <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Volunteers don't need to log in. Use the public links below whenever you need to raise something with the organisation.</p>
        ${volunteerLinksHtml}
      `
      : `
        <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName},</p>
        <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">${inviterName ? `${inviterName} has invited you` : 'You have been invited'} to join <strong>${organizationName}</strong> ${roleText}.</p>
        <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">To accept this invitation and set up your account, please click the button below:</p>
      `;

    const html = buildEmailTemplate({
      heading: isVolunteer ? 'Welcome, Volunteer' : "You're Invited",
      bodyHtml,
      buttonText: isVolunteer ? null : 'Accept Invitation',
      buttonLink: inviteLink,
      infoBoxLines: isVolunteer
        ? ['Volunteers do not need an account to help. Save this email so you can come back to the quick links above.']
        : ["If you didn't expect this invitation, you can ignore this email.", 'This link expires in 7 days.']
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send password reset email
   * @param {Object} params - Reset parameters
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.resetToken - Password reset token
   */
  async sendPasswordResetEmail({ to, recipientName, resetToken }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

    const subject = 'Reset Your Password';

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">We received a request to reset your password for your ${APP_NAME} account.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Use the button below to set a new password.</p>
    `;

    const html = buildEmailTemplate({
      heading: 'Reset Your Password',
      headingHighlight: 'Reset',
      bodyHtml,
      buttonText: 'Reset Password',
      buttonLink: resetLink,
      infoBoxLines: ["If you didn't request this, you can ignore this email.", "This link expires in 30 minutes."]
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send OTP verification code email
   * @param {Object} params - OTP parameters
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.code - 6-digit OTP code
   */
  async sendOtpEmail({ to, recipientName, code }) {
    const subject = `Your ${APP_NAME} verification code`;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Your verification code is:</p>
      <p style="margin: 16px 0; font-size: 28px; font-weight: 700; letter-spacing: 6px; text-align: center; color: #0A2E3F;">${code}</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Enter this code to complete your login. It expires in 10 minutes.</p>
    `;

    const html = buildEmailTemplate({
      heading: 'Verify Your Code',
      bodyHtml,
      buttonText: 'Enter Code',
      buttonLink: process.env.FRONTEND_URL || 'http://localhost:5173',
      infoBoxLines: ["If you didn't request this code, you can safely ignore this email.", "Never share your verification code with anyone."]
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send onboarding complete email (when initial 4 onboarding steps are done)
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.organizationName - Organization name
   */
  async sendOnboardingCompleteEmail({ to, recipientName, organizationName }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const dashboardLink = `${baseUrl}/dashboard`;

    const subject = `${organizationName} - Onboarding Complete!`;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName},</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Congratulations! You've completed the initial onboarding for <strong>${organizationName}</strong>. Your organisation is now set up and ready to use.</p>
    `;

    const html = buildEmailTemplate({
      heading: 'Onboarding Complete!',
      bodyHtml,
      buttonText: 'Go to Dashboard',
      buttonLink: dashboardLink,
      infoBoxLines: ["You can now access your dashboard and start managing compliance for your organisation."]
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send meeting invitation email
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.meetingTitle - Meeting title
   * @param {Date} params.meetingDate - Meeting date/time
   * @param {number} params.durationMinutes - Meeting duration
   * @param {string} params.location - Meeting location
   * @param {string} params.meetingLink - Meeting link (video call URL)
   * @param {string[]} params.agenda - Meeting agenda items
   * @param {string[]} params.attendeeNames - List of attendee names
   * @param {string} params.organizerName - Name of meeting organizer
   * @param {string} params.meetingId - Meeting ID for link
   */
  async sendMeetingInvitationEmail({ to, recipientName, meetingTitle, meetingDate, durationMinutes, location, meetingLink, agenda, attendeeNames, organizerName, meetingId, isExternal = false, rsvpToken }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const viewMeetingLink = `${baseUrl}/meetings/${meetingId}`;

    let rsvpButtonsHtml = '';
    if (rsvpToken && meetingId) {
      // Point the email at the frontend so emailed links use FRONTEND_URL
      // (not the backend host) and aren't tied to a hardcoded localhost.
      // The FE page does the API call to record the response, then shows
      // the existing RsvpDonePage confirmation.
      const acceptUrl = `${baseUrl}/meetings/rsvp/${meetingId}/${rsvpToken}/accept`;
      const declineUrl = `${baseUrl}/meetings/rsvp/${meetingId}/${rsvpToken}/decline`;
      rsvpButtonsHtml = `
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" style="padding-bottom: 28px;">
              <p style="margin: 0 0 12px 0; font-size: 12px; color: #6B7280;">Will you attend?</p>
              <table cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse: separate; border-spacing: 12px;">
                <tr>
                  <td align="center" style="background: #10B981; border-radius: 50px; box-shadow: 0px 2px 8px rgba(16, 185, 129, 0.4);">
                    <a href="${acceptUrl}" style="display: inline-block; padding: 12px 28px; text-decoration: none; color: #FFFFFF; font-size: 14px; font-weight: 600;">Yes, I'll attend</a>
                  </td>
                  <td align="center" style="background: #EF4444; border-radius: 50px; box-shadow: 0px 2px 8px rgba(239, 68, 68, 0.4);">
                    <a href="${declineUrl}" style="display: inline-block; padding: 12px 28px; text-decoration: none; color: #FFFFFF; font-size: 14px; font-weight: 600;">No, I can't attend</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
    }

    const formattedDate = new Date(meetingDate).toLocaleDateString('en-AU', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const formattedTime = new Date(meetingDate).toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit'
    });

    const subject = `Meeting Invitation: ${meetingTitle}`;

    const attendeesHtml = attendeeNames && attendeeNames.length > 0
      ? `<p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Attendees:</strong> ${attendeeNames.slice(0, 5).join(', ')}${attendeeNames.length > 5 ? ` +${attendeeNames.length - 5} more` : ''}</p>`
      : '';

    const agendaItems = Array.isArray(agenda)
      ? agenda
      : typeof agenda === 'string' && agenda.trim()
        ? [agenda.trim()]
        : [];

    const agendaHtml = agendaItems.length > 0
      ? `<div style="margin: 12px 0; text-align: left;"><p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 600; color: #333333;">Agenda:</p><ul style="margin: 0; padding-left: 20px;">${agendaItems.map(item => `<li style="font-size: 12px; color: #333333; margin: 4px 0;">${item}</li>`).join('')}</ul></div>`
      : '';

    const meetingLinkHtml = meetingLink
      ? `<p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Meeting Link:</strong> <a href="${meetingLink}" style="color: #117A8B; text-decoration: none;">${meetingLink}</a></p>`
      : '';

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName},</p>
      <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">You have been invited to a meeting by <strong>${organizerName}</strong>.</p>
      <div style="background: #F8F9FA; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #0A2E3F;">${meetingTitle}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Date:</strong> ${formattedDate}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Time:</strong> ${formattedTime} (${durationMinutes} minutes)</p>
        ${location ? `<p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Location:</strong> ${location}</p>` : ''}
        ${meetingLinkHtml}
        ${attendeesHtml}
        ${agendaHtml}
      </div>
    `;

    const html = buildEmailTemplate({
      heading: 'Meeting Invitation',
      bodyHtml,
      buttonText: 'View Meeting',
      buttonLink: viewMeetingLink,
      infoBoxLines: rsvpToken ? ['Click Accept or Decline above to let the organizer know.', 'Add this meeting to your calendar.'] : ['Please confirm your attendance.', 'Add this meeting to your calendar.'],
      rsvpButtonsHtml
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send meeting notes update email
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.meetingTitle - Meeting title
   * @param {string} params.noteContent - The note that was added
   * @param {string} params.addedByName - Name of person who added the note
   * @param {string} params.meetingId - Meeting ID for link
   */
  async sendMeetingNotesEmail({ to, recipientName, meetingTitle, noteContent, addedByName, meetingId }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const viewMeetingLink = `${baseUrl}/meetings/${meetingId}?tab=notes`;

    const subject = `New Note Added: ${meetingTitle}`;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName},</p>
      <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;"><strong>${addedByName}</strong> has added a new note to the meeting <strong>${meetingTitle}</strong>.</p>
      <div style="background: #F8F9FA; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: #0A2E3F;">Note:</p>
        <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333;">${noteContent}</p>
      </div>
    `;

    const html = buildEmailTemplate({
      heading: 'Meeting Notes Updated',
      bodyHtml,
      buttonText: 'View Meeting Notes',
      buttonLink: viewMeetingLink,
      infoBoxLines: ["Stay updated with the latest meeting notes."]
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send policy resubmission required email (when decline is upheld)
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.policyTitle - Policy title
   * @param {string} params.approvalRequestId - Approval request ID for link
   */
  async sendPolicyResubmissionRequiredEmail({ to, recipientName, policyTitle, approvalRequestId }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const viewLink = `${baseUrl}/approvals/${approvalRequestId}`;

    const subject = `Resubmission Required: ${policyTitle}`;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName},</p>
      <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Your policy <strong>${policyTitle}</strong> was declined and the decline has been upheld. Please review the comments, make any needed changes, and resubmit for approval.</p>
    `;

    const html = buildEmailTemplate({
      heading: 'Resubmission Required',
      bodyHtml,
      buttonText: 'Review & Resubmit',
      buttonLink: viewLink,
      infoBoxLines: ['You can view all feedback in the approval trail.', 'Edit the policy document if needed, then resubmit.']
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send external training invite (no login required).
   * @param {Object} params
   * @param {string} params.to
   * @param {string} params.recipientName
   * @param {string} params.trainingTitle
   * @param {string} params.trainingLink
   */
  async sendExternalTrainingInvite({ to, recipientName, trainingTitle, trainingLink }) {
    const subject = `Training assigned: ${trainingTitle}`;
    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
        Hi ${recipientName || 'there'},
      </p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
        You have been invited to complete the training <strong>${trainingTitle}</strong>.
      </p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
        Use the button below to open your training link. No portal login is required.
      </p>
    `;
    const html = buildEmailTemplate({
      heading: 'Training Assigned',
      bodyHtml,
      buttonText: 'Start Training',
      buttonLink: trainingLink,
      infoBoxLines: ['This link is unique to you. Please do not share it.', 'Your progress and completion will be recorded for compliance reporting.']
    });
    return this.sendEmail({ to, subject, html });
  }

  async sendVolunteerTrainingNotification({ to, recipientName, trainingTitle }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const subject = `Volunteer training assigned: ${trainingTitle}`;
    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName || 'Volunteer'},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">A new training has been assigned to you: <strong>${trainingTitle}</strong>.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Please open your dashboard and complete it.</p>
    `;
    const html = buildEmailTemplate({
      heading: 'Training Assigned',
      bodyHtml,
      buttonText: 'Open My Training',
      buttonLink: `${baseUrl}/human-resources/my-training`,
      infoBoxLines: ['This is part of your compliance requirements.'],
    });
    return this.sendEmail({ to, subject, html });
  }

  async sendVolunteerPolicyNotification({ to, recipientName, policyTitle, policyId, acknowledgeUrl }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // Volunteers have no login. Prefer the public token link when provided so they
    // can acknowledge without authenticating; fall back to the internal route.
    const buttonLink = acknowledgeUrl || `${baseUrl}/policies/acknowledge/${policyId}`;
    const subject = `Policy for your acknowledgement: ${policyTitle}`;
    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName || 'Volunteer'},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">A policy relevant to you has been added or updated: <strong>${policyTitle}</strong>.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Please review it and confirm your acknowledgement using the link below. No login required.</p>
    `;
    const html = buildEmailTemplate({
      heading: 'Policy Acknowledgement Required',
      bodyHtml,
      buttonText: 'Review & acknowledge',
      buttonLink,
      infoBoxLines: ['Your acknowledgement is tracked for compliance reporting.']
    });
    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send approval request email (notify assignees that action is required)
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.approvalRequestId - Approval request ID
   * @param {string} params.requestType - Type of request (expense, risk, policy, etc.)
   * @param {string} params.entityTitle - Title/description of the entity being approved
   * @param {number} params.approvalLevel - What level this approver is at
   * @param {string} params.submitterName - Name of person who submitted
   * @param {string} params.approvalType - Sequential, parallel, or any
   */
  async sendApprovalRequestEmail({ to, recipientName, approvalRequestId, requestType, entityTitle, approvalLevel, submitterName, approvalType = 'sequential' }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const approvalLink = `${baseUrl}/approvals/${approvalRequestId}`;
    
    const typeLabel = {
      expense: 'Expense',
      purchase: 'Purchase',
      risk: 'Risk',
      policy: 'Policy',
      grant: 'Grant',
      funding: 'Funding Agreement',
      donation: 'Donation',
      contract: 'Contract',
      complaint: 'Complaint'
    }[requestType] || requestType.charAt(0).toUpperCase() + requestType.slice(1);

    const subject = `Action Required: ${typeLabel} approval - ${entityTitle}`;

    const urgencyText = approvalType === 'sequential' 
      ? 'This is a sequential approval workflow. You are step ' + approvalLevel + '.'
      : 'You are one of the approvers for this request.';

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName},</p>
      <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">A new <strong>${typeLabel}</strong> approval request requires your action. ${submitterName ? `<strong>${submitterName}</strong> submitted it.` : ''}</p>
      <div style="background: #F8F9FA; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #0A2E3F;">Request Details:</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Type:</strong> ${typeLabel}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Item:</strong> ${entityTitle}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Your Role:</strong> Level ${approvalLevel} approver - ${urgencyText}</p>
      </div>
    `;

    const html = buildEmailTemplate({
      heading: 'New Approval Required',
      bodyHtml,
      buttonText: 'Review & Approve',
      buttonLink: approvalLink,
      infoBoxLines: [
        'Please review all details carefully before making your decision.',
        'Your approval can be approved, rejected, or escalated for additional opinion.'
      ]
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send approval decision email (notify submitter and other stakeholders)
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.approvalRequestId - Approval request ID
   * @param {string} params.requestType - Type of request
   * @param {string} params.entityTitle - Title of entity
   * @param {string} params.decision - 'approved' or 'rejected'
   * @param {string} params.decidedByName - Name of approver who made decision
   * @param {string} params.comments - Any comments/rejection reason
   * @param {number} [params.remainingSteps] - Number of steps remaining (for sequential)
   */
  async sendApprovalDecisionEmail({ to, recipientName, approvalRequestId, requestType, entityTitle, decision, decidedByName, comments, remainingSteps }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const approvalLink = `${baseUrl}/approvals/${approvalRequestId}`;

    const typeLabel = {
      expense: 'Expense',
      purchase: 'Purchase',
      risk: 'Risk',
      policy: 'Policy',
      grant: 'Grant',
      funding: 'Funding Agreement',
      donation: 'Donation',
      contract: 'Contract',
      complaint: 'Complaint'
    }[requestType] || requestType.charAt(0).toUpperCase() + requestType.slice(1);

    const isApproved = decision === 'approved';
    const subject = `${typeLabel} ${isApproved ? 'Approved' : 'Rejected'}: ${entityTitle}`;
    
    const statusColor = isApproved ? '#10B981' : '#EF4444';
    const statusText = isApproved ? 'APPROVED' : 'REJECTED';
    const statusBg = isApproved ? '#D1FAE5' : '#FEE2E2';
    
    const stepsInfo = remainingSteps !== undefined && !isApproved
      ? `<p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Remaining Steps:</strong> ${remainingSteps}</p>`
      : '';

    const commentsSection = comments
      ? `<p style="margin: 12px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Comments:</strong></p><p style="margin: 0; padding: 8px; background: #F3F4F6; border-left: 3px solid ${statusColor}; font-size: 12px; color: #333333;">${comments}</p>`
      : '';

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName},</p>
      <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;"><strong>${decidedByName}</strong> has <strong>${isApproved ? 'approved' : 'rejected'}</strong> the ${typeLabel.toLowerCase()} for <strong>${entityTitle}</strong>.</p>
      <div style="background: ${statusBg}; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: center; border: 2px solid ${statusColor};">
        <p style="margin: 0; font-size: 16px; font-weight: 700; color: ${statusColor};">${statusText}</p>
      </div>
      <div style="background: #F8F9FA; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #0A2E3F;">Decision Details:</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Request:</strong> ${entityTitle}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Decided By:</strong> ${decidedByName}</p>
        ${stepsInfo}
        ${commentsSection}
      </div>
    `;

    const html = buildEmailTemplate({
      heading: isApproved ? 'Request Approved' : 'Request Declined',
      bodyHtml,
      buttonText: 'View Details',
      buttonLink: approvalLink,
      infoBoxLines: isApproved 
        ? ['Your request has been approved. Next steps will follow.']
        : ['Please review the comments and take any necessary action.']
    });

    return this.sendEmail({ to, subject, html });
  }

  /**
   * Send escalation request email (request opinion from colleague)
   * @param {Object} params
   * @param {string} params.to - Recipient email
   * @param {string} params.recipientName - Recipient's name
   * @param {string} params.approvalRequestId - Approval request ID
   * @param {string} params.requestType - Type of request
   * @param {string} params.entityTitle - Title of entity
   * @param {string} params.escalatedByName - Name of person requesting opinion
   * @param {string} params.requestComments - Comments/context for the escalation
   */
  async sendEscalationRequestEmail({ to, recipientName, approvalRequestId, requestType, entityTitle, escalatedByName, requestComments }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const approvalLink = `${baseUrl}/approvals/${approvalRequestId}`;

    const typeLabel = {
      expense: 'Expense',
      purchase: 'Purchase',
      risk: 'Risk',
      policy: 'Policy',
      grant: 'Grant',
      funding: 'Funding Agreement',
      donation: 'Donation',
      contract: 'Contract',
      complaint: 'Complaint'
    }[requestType] || requestType.charAt(0).toUpperCase() + requestType.slice(1);

    const subject = `Opinion Requested: ${typeLabel} review - ${entityTitle}`;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;">Hi ${recipientName},</p>
      <p style="margin: 0 0 16px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center;"><strong>${escalatedByName}</strong> is requesting your input/opinion on a ${typeLabel.toLowerCase()} before they make their final decision.</p>
      <div style="background: #F8F9FA; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #0A2E3F;">Request for Opinion:</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Request Type:</strong> ${typeLabel}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Item:</strong> ${entityTitle}</p>
        <p style="margin: 8px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Requested By:</strong> ${escalatedByName}</p>
        ${requestComments ? `<p style="margin: 12px 0; font-size: 12px; line-height: 18px; color: #333333;"><strong>Context:</strong></p><p style="margin: 0; padding: 8px; background: #FFFFFF; border-left: 3px solid #117A8B; font-size: 12px; color: #333333;">${requestComments}</p>` : ''}
      </div>
    `;

    const html = buildEmailTemplate({
      heading: 'Your Opinion Requested',
      bodyHtml,
      buttonText: 'Provide Your Input',
      buttonLink: approvalLink,
      infoBoxLines: [
        'Your opinion will help the approver make a better decision.',
        'They will proceed with the approval once you respond.'
      ]
    });

    return this.sendEmail({ to, subject, html });
  }

  async sendProjectRefundExternalFormEmail({ to, recipientName, projectName, refundAmount, formLink }) {
    const subject = `Refund receipts required: ${projectName}`;
    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName || 'Partner'},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Please submit the refund receipts/payment proof for <strong>${projectName || 'your project'}</strong>${refundAmount ? ` (refund amount: <strong>${refundAmount}</strong>)` : ''}.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Use the button below to upload receipts and add any notes.</p>
    `;

    const html = buildEmailTemplate({
      heading: 'Refund receipts required',
      bodyHtml,
      buttonText: 'Submit receipts',
      buttonLink: formLink,
      infoBoxLines: [
        "If you didn't expect this request, please contact the organisation.",
        'This link may be used to submit your receipts once.'
      ]
    });

    return this.sendEmail({ to, subject, html });
  }

  async sendProjectProgressReportExternalFormEmail({ to, recipientName, projectName, reportType, formLink }) {
    const label = String(reportType || 'interim').toLowerCase() === 'final' ? 'Final' : 'Interim';
    const subject = `${label} progress report required: ${projectName}`;
    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName || 'Partner'},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Please submit the <strong>${label.toLowerCase()}</strong> progress report for <strong>${projectName || 'your project'}</strong>.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">This report includes project narrative, impact, financials (if final), acquittals/invoices, and media.</p>
    `;

    const html = buildEmailTemplate({
      heading: `${label} Progress Report`,
      bodyHtml,
      buttonText: 'Submit report',
      buttonLink: formLink,
      infoBoxLines: [
        'Please submit accurate information and attach any supporting files.',
        'If you cannot access the link, contact the organisation for a new request.'
      ]
    });

    return this.sendEmail({ to, subject, html });
  }

  async sendFundingAgreementPartnerSignatureRequestEmail({ to, partnerName, agreementTitle, signLink, expiryDate }) {
    const safeTitle = agreementTitle || 'Funding agreement';
    const subject = `Signature requested: ${safeTitle}`;
    const expiryStr = expiryDate
      ? new Date(expiryDate).toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })
      : null;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${partnerName || 'Partner'},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">The funding agreement <strong>${safeTitle}</strong> has been signed internally and is now ready for your signature.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Please review the agreement and add your signature using the secure link below.</p>
    `;

    const infoBoxLines = [
      'The link is unique to you — please do not share it.',
      expiryStr ? `This link expires on ${expiryStr}.` : 'This link will expire after 14 days.'
    ];

    const html = buildEmailTemplate({
      heading: 'Funding agreement signature requested',
      bodyHtml,
      buttonText: 'Review & sign agreement',
      buttonLink: signLink,
      infoBoxLines
    });

    return this.sendEmail({ to, subject, html });
  }
}

export default new EmailService();
export { buildEmailTemplate };