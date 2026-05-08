/**
 * Billing-related email helpers — wrap the brand template with copy
 * appropriate for each subscription event. Caller passes the recipient
 * email + a few facts; this builds the HTML and ships via emailService.
 *
 * Every helper is fire-and-forget: errors are logged, never thrown,
 * because billing flows must complete even if SMTP is down.
 */

import emailService, { buildEmailTemplate } from './emailService.js';

const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN?.split(',')?.[0] || 'http://localhost:5173').replace(/\/$/, '');

const fmtMoney = (n, currency = 'AUD') => {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n));
};
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

async function trySend(args) {
  try {
    await emailService.sendEmail(args);
  } catch (err) {
    console.error('[billingEmails] non-fatal:', args.subject, err?.message || err);
  }
}

/* ── Welcome / receipt — fires on checkout.session.completed ─────── */
export async function sendSubscriptionWelcome({ to, orgName, planName, amountAUD, billingCycle, periodEndAt, isTrial }) {
  if (!to) return;
  const cycleLabel = billingCycle === 'yearly' ? 'year' : 'month';
  const html = buildEmailTemplate({
    heading: isTrial ? 'Your trial has started' : 'Welcome — subscription active',
    headingHighlight: isTrial ? 'Your' : 'Welcome',
    bodyHtml: `
      <p style="margin: 0 0 14px 0;">Hi${orgName ? ` ${orgName}` : ''},</p>
      <p style="margin: 0 0 14px 0;">${isTrial
        ? `Your ${planName} trial has started. You'll have full access until <strong>${fmtDate(periodEndAt)}</strong>; we'll charge ${fmtMoney(amountAUD)} per ${cycleLabel} after that.`
        : `Your ${planName} subscription is active. We charged <strong>${fmtMoney(amountAUD)}</strong> per ${cycleLabel} and your next renewal is on ${fmtDate(periodEndAt)}.`}</p>
      <p style="margin: 0;">Open Stewardex to start managing your compliance work.</p>
    `,
    buttonText: 'Open Stewardex',
    buttonLink: `${FRONTEND_URL}/dashboard`,
    infoBoxLines: [
      `Plan: ${planName}`,
      `Cycle: ${billingCycle === 'yearly' ? 'Annual' : 'Monthly'}`,
      `Renews: ${fmtDate(periodEndAt)}`
    ]
  });
  await trySend({ to, subject: isTrial ? `Your ${planName} trial has started` : `Welcome to Stewardex ${planName}`, html });
}

/* ── Past-due — fires on invoice.payment_failed ──────────────────── */
export async function sendPastDueAlert({ to, orgName, planName, amountAUD, attemptCount }) {
  if (!to) return;
  const html = buildEmailTemplate({
    heading: 'Action required — payment failed',
    headingHighlight: 'Action',
    bodyHtml: `
      <p style="margin: 0 0 14px 0;">Hi${orgName ? ` ${orgName}` : ''},</p>
      <p style="margin: 0 0 14px 0;">We tried to charge <strong>${fmtMoney(amountAUD)}</strong> for your ${planName} subscription and the payment failed${attemptCount > 1 ? ` (attempt ${attemptCount})` : ''}.</p>
      <p style="margin: 0 0 14px 0;">To keep your access active, please update your card. Your data is preserved while we retry.</p>
    `,
    buttonText: 'Update payment method',
    buttonLink: `${FRONTEND_URL}/billing`,
    infoBoxLines: [
      'Stripe will retry automatically for the next few days.',
      'After several failed attempts your subscription will pause.',
      'Need help? Reply to this email.'
    ]
  });
  await trySend({ to, subject: `Payment failed — Stewardex ${planName}`, html });
}

/* ── Trial ending in N days ─────────────────────────────────────── */
export async function sendTrialEnding({ to, orgName, planName, amountAUD, billingCycle, periodEndAt, daysLeft }) {
  if (!to) return;
  const cycleLabel = billingCycle === 'yearly' ? 'year' : 'month';
  const html = buildEmailTemplate({
    heading: `Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    headingHighlight: 'Your',
    bodyHtml: `
      <p style="margin: 0 0 14px 0;">Hi${orgName ? ` ${orgName}` : ''},</p>
      <p style="margin: 0 0 14px 0;">Your ${planName} trial ends on <strong>${fmtDate(periodEndAt)}</strong>. After that we'll charge <strong>${fmtMoney(amountAUD)}</strong> per ${cycleLabel} on the card you provided.</p>
      <p style="margin: 0;">If you'd like to switch plans or cancel, you can do that any time from billing.</p>
    `,
    buttonText: 'Manage subscription',
    buttonLink: `${FRONTEND_URL}/billing`,
    infoBoxLines: [
      `Plan: ${planName}`,
      `First charge: ${fmtDate(periodEndAt)}`,
      `Amount: ${fmtMoney(amountAUD)} per ${cycleLabel}`
    ]
  });
  await trySend({ to, subject: `Your Stewardex trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, html });
}

/* ── Subscription cancelled ─────────────────────────────────────── */
export async function sendCancellationConfirmation({ to, orgName, planName, periodEndAt }) {
  if (!to) return;
  const html = buildEmailTemplate({
    heading: 'Subscription cancelled',
    bodyHtml: `
      <p style="margin: 0 0 14px 0;">Hi${orgName ? ` ${orgName}` : ''},</p>
      <p style="margin: 0 0 14px 0;">Your ${planName} subscription has been cancelled${periodEndAt ? ` and access will continue until <strong>${fmtDate(periodEndAt)}</strong>.` : '.'}</p>
      <p style="margin: 0;">If this was a mistake, you can resubscribe any time. We'll keep your data for 90 days.</p>
    `,
    buttonText: 'Resubscribe',
    buttonLink: `${FRONTEND_URL}/billing`,
    infoBoxLines: [
      `Plan: ${planName}`,
      periodEndAt ? `Access until: ${fmtDate(periodEndAt)}` : 'Access ends now',
      'Data retention: 90 days'
    ]
  });
  await trySend({ to, subject: `Stewardex ${planName} cancelled`, html });
}

/* ── Plan changed by SuperAdmin (assigned / migrated) ──────────── */
export async function sendPlanChangeNotice({ to, orgName, planName, billingCycle, amountAUD, reason }) {
  if (!to) return;
  const cycleLabel = billingCycle === 'yearly' ? 'year' : 'month';
  const html = buildEmailTemplate({
    heading: 'Your plan was updated',
    headingHighlight: 'Your',
    bodyHtml: `
      <p style="margin: 0 0 14px 0;">Hi${orgName ? ` ${orgName}` : ''},</p>
      <p style="margin: 0 0 14px 0;">Your subscription has been updated to the <strong>${planName}</strong> plan${amountAUD != null ? ` at <strong>${fmtMoney(amountAUD)}</strong> per ${cycleLabel}` : ''}.</p>
      ${reason ? `<p style="margin: 0 0 14px 0;">Reason: ${reason}</p>` : ''}
      <p style="margin: 0;">Open billing to see what's included and your next renewal date.</p>
    `,
    buttonText: 'Open billing',
    buttonLink: `${FRONTEND_URL}/billing`,
    infoBoxLines: amountAUD != null ? [
      `New plan: ${planName}`,
      `Cycle: ${billingCycle === 'yearly' ? 'Annual' : 'Monthly'}`,
      `Amount: ${fmtMoney(amountAUD)} per ${cycleLabel}`
    ] : [`New plan: ${planName}`]
  });
  await trySend({ to, subject: `Your Stewardex plan was updated`, html });
}
