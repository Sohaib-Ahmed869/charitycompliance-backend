/**
 * Email Service
 *
 * Handles sending emails using nodemailer with SMTP
 * Templates follow Yathic design: purple gradient background, logo, tagline, CTA, info box, footer
 */

import nodemailer from 'nodemailer';
import { logError, logInfo } from '../utils/logger.js';

const APP_NAME = process.env.APP_NAME || 'Yathic';
const LOGO_URL = process.env.logo || process.env.LOGO_URL || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@yathic.com';

const GRADIENT = 'linear-gradient(103.82deg, #132E5E 6.74%, #9A78EC 76.18%)';

/**
 * Build base email HTML with Yathic design (from provided template)
 * @param {Object} options
 * @param {string} options.heading - Main heading (e.g. "Reset Your Password")
 * @param {string} options.bodyHtml - Main body content (HTML)
 * @param {string} options.buttonText - CTA button text
 * @param {string} options.buttonLink - CTA button href
 * @param {string[]} options.infoBoxLines - Info box lines (array of strings)
 */
function buildEmailTemplate({ heading, bodyHtml, buttonText, buttonLink, infoBoxLines }) {
  const logoHtml = LOGO_URL
    ? `<img src="${LOGO_URL}" alt="${APP_NAME}" style="max-width: 160px; height: auto;" />`
    : `<div style="font-size: 36px; font-weight: 500; color: #132E5E; letter-spacing: 2px;">${APP_NAME.toLowerCase()}</div>`;

  const lockIcon = '🔒'; // Simple emoji fallback for better email client compatibility

  const infoBoxContent = infoBoxLines && infoBoxLines.length
    ? infoBoxLines.map((line, i) => `<p style="margin: ${i === 0 ? '0 0 4px 0' : '0'}; font-size: 12px; line-height: 15px; color: rgba(0, 0, 0, 0.8); font-weight: 400;">${line}</p>`).join('')
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${APP_NAME} - ${heading}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <!-- Main email container with gradient background -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background: linear-gradient(135deg, rgba(154, 120, 236, 0.08) 0%, rgba(19, 46, 94, 0.05) 100%), #FFFFFF; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
                    <tr>
                        <td style="padding: 44px 30px 60px 30px;">
                            <!-- Logo Section -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 10px;">
                                        ${logoHtml}
                                    </td>
                                </tr>
                                <tr>
                                    <td align="center" style="padding-bottom: 36px;">
                                        <p style="margin: 0; font-size: 10px; line-height: 12px; color: #666666; font-weight: 400;">End to End Compliance Made Easy!</p>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Main Heading -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 24px;">
                                        <h1 style="margin: 0; font-size: 36px; line-height: 46px; font-weight: 600; text-align: center; color: #132E5E;">${heading}</h1>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Body Content -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding: 0 20px 32px;">
                                        ${bodyHtml}
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- CTA Button -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 32px;">
                                        <table cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td align="center" style="background: linear-gradient(103.82deg, #132E5E 6.74%, #9A78EC 76.18%); border-radius: 50px; box-shadow: 0px 4px 20px rgba(154, 120, 236, 0.45);">
                                                    <a href="${buttonLink}" style="display: inline-block; padding: 14px 32px; text-decoration: none; color: #FFFFFF; font-size: 14px; font-weight: 600; border-radius: 50px;">
                                                        ${buttonText} →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Info Box -->
                            ${infoBoxContent ? `
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center" style="padding: 0 20px 40px;">
                                        <table cellpadding="0" cellspacing="0" border="0" style="max-width: 420px; border: 1px solid #E5E5E5; border-radius: 10px; background: #FAFAFA;">
                                            <tr>
                                                <td style="padding: 16px 20px;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="30" valign="top" style="padding-right: 12px; font-size: 20px; color: #9A78EC;">
                                                                ${lockIcon}
                                                            </td>
                                                            <td>
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
                                    <td align="center" style="border-top: 1px solid #E5E5E5; padding-top: 24px;">
                                        <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 18px; color: #666666; font-weight: 400;">© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
                                        <p style="margin: 0 0 8px 0; font-size: 12px; line-height: 18px; color: #666666; font-weight: 400;">
                                            Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color: #9A78EC; text-decoration: none;">${SUPPORT_EMAIL}</a>
                                        </p>
                                        <p style="margin: 0; font-size: 12px; line-height: 18px; font-weight: 400;">
                                            <a href="#" style="color: #9A78EC; text-decoration: none;">Privacy Policy</a>
                                            <span style="color: #666666;"> • </span>
                                            <a href="#" style="color: #9A78EC; text-decoration: none;">Terms</a>
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
  }

  /**
   * Initialize the email transporter
   */
  async initialize() {
    if (this.initialized) return;

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

      // Verify connection (with timeout - avoid hanging on unreachable SMTP)
      await Promise.race([
        this.transporter.verify(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP verify timeout')), 10000))
      ]);
      this.initialized = true;
      logInfo('Email service initialized successfully');
    } catch (error) {
      logError('Failed to initialize email service', error);
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
  async sendEmail({ to, subject, html, text }) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const mailOptions = {
        from: `"${process.env.EMAIL_FROM_NAME || 'Charity Compliance'}" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for text version
      };

      const result = await Promise.race([
        this.transporter.sendMail(mailOptions),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP send timeout (15s)')), 15000))
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
  async sendBoardMemberInvitation({ to, recipientName, organizationName, position, invitationToken, inviterName }) {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const inviteLink = `${baseUrl}/invitation/${invitationToken}`;

    const subject = `You've been invited to join ${organizationName}`;

    const bodyHtml = `
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">Hi ${recipientName},</p>
      <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">${inviterName ? `${inviterName} has invited you` : 'You have been invited'} to join <strong>${organizationName}</strong> as a <strong>${position}</strong>.</p>
      <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">To accept this invitation and set up your account, please click the button below:</p>
    `;

    const html = buildEmailTemplate({
      heading: "You're Invited",
      bodyHtml,
      buttonText: 'Accept Invitation',
      buttonLink: inviteLink,
      infoBoxLines: ["If you didn't expect this invitation, you can ignore this email.", "This link expires in 7 days."]
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
      <p style="margin: 16px 0; font-size: 28px; font-weight: 700; letter-spacing: 6px; text-align: center; color: #132E5E;">${code}</p>
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
}

export default new EmailService();