/**
 * Email Service
 *
 * Handles sending emails using nodemailer with SMTP
 */

import nodemailer from 'nodemailer';
import { logError, logInfo } from '../utils/logger.js';

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
        }
      });

      // Verify connection
      await this.transporter.verify();
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

      const result = await this.transporter.sendMail(mailOptions);
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

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Board Member Invitation</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 40px 0;">
              <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <tr>
                  <td style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 40px 40px 30px;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                      Welcome to ${organizationName}
                    </h1>
                  </td>
                </tr>

                <!-- Body -->
                <tr>
                  <td style="padding: 40px;">
                    <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.6;">
                      Hi ${recipientName},
                    </p>

                    <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.6;">
                      ${inviterName ? `${inviterName} has` : 'You have been'} invited you to join <strong>${organizationName}</strong> as a <strong>${position}</strong>.
                    </p>

                    <p style="margin: 0 0 30px; color: #374151; font-size: 16px; line-height: 1.6;">
                      To accept this invitation and set up your account, please click the button below:
                    </p>

                    <!-- CTA Button -->
                    <table role="presentation" style="margin: 0 auto 30px;">
                      <tr>
                        <td style="border-radius: 8px; background-color: #1e293b;">
                          <a href="${inviteLink}" style="display: inline-block; padding: 16px 32px; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600;">
                            Accept Invitation
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 0 0 20px; color: #6b7280; font-size: 14px; line-height: 1.6;">
                      Or copy and paste this link into your browser:
                    </p>

                    <p style="margin: 0 0 30px; padding: 12px; background-color: #f3f4f6; border-radius: 6px; word-break: break-all;">
                      <a href="${inviteLink}" style="color: #3485FF; text-decoration: none; font-size: 14px;">${inviteLink}</a>
                    </p>

                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px; line-height: 1.6;">
                      This invitation link will expire in 7 days.
                    </p>

                    <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                      If you didn't expect this invitation, you can safely ignore this email.
                    </p>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="padding: 30px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
                    <p style="margin: 0; color: #9ca3af; font-size: 12px; text-align: center;">
                      This email was sent by ${organizationName} via Charity Compliance Platform.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

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

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 40px 0;">
              <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 40px 40px 30px;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                      Password Reset Request
                    </h1>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 40px;">
                    <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.6;">
                      Hi ${recipientName},
                    </p>

                    <p style="margin: 0 0 30px; color: #374151; font-size: 16px; line-height: 1.6;">
                      We received a request to reset your password. Click the button below to create a new password:
                    </p>

                    <table role="presentation" style="margin: 0 auto 30px;">
                      <tr>
                        <td style="border-radius: 8px; background-color: #1e293b;">
                          <a href="${resetLink}" style="display: inline-block; padding: 16px 32px; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600;">
                            Reset Password
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 0 0 10px; color: #6b7280; font-size: 14px; line-height: 1.6;">
                      This link will expire in 1 hour.
                    </p>

                    <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                      If you didn't request this, you can safely ignore this email.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    return this.sendEmail({ to, subject, html });
  }
}

export default new EmailService();
