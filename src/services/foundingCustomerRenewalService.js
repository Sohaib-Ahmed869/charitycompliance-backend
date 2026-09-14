/**
 * Founding Customer renewal sweep (handbook §17.3 + arch §11).
 *
 * The Founding Customer promo grants 15% off forever AND a 24-month
 * price-lock — meaning the tenant pays today's price for two years
 * regardless of any plan price changes. At month 25 (the lock expires)
 * we step them up to current list with 30 days' notice.
 *
 *   1. Daily sweep finds tenants with `metadata.founding_customer === true`
 *      whose `metadata.price_locked_until` is between now and 30 days out.
 *   2. If we haven't already sent the notice (`metadata.fc_notice_sent_at`
 *      missing or older than the lock-end), send a price-step-up email +
 *      stamp the date.
 *   3. After the lock expires, the next renewal naturally bills the
 *      current list price (Stripe pulls fresh price). No code action
 *      needed at the actual switchover — the notice IS the action.
 *
 * Boots from server.js when BACKGROUND_JOBS_ENABLED=true.
 */

import getRouterModels from '../db/models/routerModels.js';
import { logInfo, logError } from '../utils/logger.js';
import { maskEmail } from '../utils/maskPii.js';
import { buildEmailTemplate } from './emailService.js';
import emailService from './emailService.js';
import { getOrgOwnerEmail } from '../utils/getOrgOwnerEmail.js';

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const NOTICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days before lock expiry
const BOOT_DELAY_MS = Number(process.env.REMINDERS_RUN_ON_BOOT_DELAY_MS) || 8000;

let _timer = null;

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].replace(/\/$/, '');

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

async function sendStepUpNotice({ to, orgName, planName, lockEndsAt }) {
  if (!to) return;
  const html = buildEmailTemplate({
    heading: 'Founding Customer pricing ends soon',
    headingHighlight: 'Founding',
    bodyHtml: `
      <p style="margin: 0 0 14px 0;">Hi${orgName ? ` ${orgName}` : ''},</p>
      <p style="margin: 0 0 14px 0;">
        Thank you for being one of our Founding Customers — your 24-month
        price lock expires on <strong>${fmtDate(lockEndsAt)}</strong>.
      </p>
      <p style="margin: 0 0 14px 0;">
        From your next renewal after that date, your subscription will
        bill at the current ${planName || 'plan'} price. Your 15% Founding
        Customer discount continues to apply on every cycle, forever.
      </p>
      <p style="margin: 0 0 14px 0;">
        If you'd like to lock in your current rate by switching to
        annual billing (typically saves another 17%), or if you have
        any questions about the change, just reply to this email.
      </p>
    `,
    buttonText: 'Open billing',
    buttonLink: `${FRONTEND_URL}/billing`,
    infoBoxLines: [
      `Lock expires: ${fmtDate(lockEndsAt)}`,
      'After this date: current list price - 15% (forever)',
      'Want to lock in further? Switch to annual on /billing.'
    ]
  });
  try {
    await emailService.sendEmail({
      to,
      subject: 'Heads up — your Founding Customer price lock ends soon',
      html
    });
  } catch (err) {
    logError('foundingCustomerRenewal: email send failed', err, { to: maskEmail(to) });
  }
}

export async function runFoundingCustomerRenewalsOnce() {
  try {
    const { Tenant, OrganizationSubscription, SubscriptionPlan } = getRouterModels();
    const now = Date.now();
    const cutoff = new Date(now + NOTICE_WINDOW_MS);

    // Tenants in the notice window — locked between today and +30 days.
    const candidates = await Tenant.find({
      'metadata.founding_customer': true,
      'metadata.price_locked_until': { $gte: new Date(now), $lte: cutoff }
    }).lean();

    if (candidates.length === 0) return { swept: 0 };

    let sent = 0;
    for (const tenant of candidates) {
      try {
        const lockEndsAt = tenant.metadata?.price_locked_until;
        const lastNotice = tenant.metadata?.fc_notice_sent_at
          ? new Date(tenant.metadata.fc_notice_sent_at).getTime()
          : 0;
        // Only send once per lock period — if the notice was sent and
        // the lock hasn't been reset, skip.
        if (lastNotice > now - NOTICE_WINDOW_MS) continue;

        const ownerEmail = await getOrgOwnerEmail(tenant.orgId).catch(() => null);
        if (!ownerEmail) continue;

        const sub = await OrganizationSubscription.findOne({ organization_id: tenant.orgId }).lean();
        const plan = sub?.plan_id ? await SubscriptionPlan.findById(sub.plan_id).lean() : null;

        await sendStepUpNotice({
          to: ownerEmail,
          orgName: tenant.orgId,
          planName: plan?.plan_name || 'your plan',
          lockEndsAt
        });

        await Tenant.updateOne(
          { _id: tenant._id },
          { $set: { 'metadata.fc_notice_sent_at': new Date() } }
        );
        sent += 1;
      } catch (err) {
        logError('foundingCustomerRenewal: per-tenant error', err, { orgId: tenant.orgId });
      }
    }

    if (sent > 0) {
      logInfo('foundingCustomerRenewal: notices sent', { sent, swept: candidates.length });
    }
    return { swept: candidates.length, sent };
  } catch (err) {
    logError('foundingCustomerRenewal: top-level error', err);
    return { swept: 0, error: err?.message || String(err) };
  }
}

export function startFoundingCustomerRenewalScheduler() {
  if (_timer) return;
  setTimeout(() => { runFoundingCustomerRenewalsOnce().catch(() => {}); }, BOOT_DELAY_MS);
  _timer = setInterval(() => { runFoundingCustomerRenewalsOnce().catch(() => {}); }, SWEEP_INTERVAL_MS);
  logInfo('foundingCustomerRenewal: scheduler started', { interval_ms: SWEEP_INTERVAL_MS });
}

export function stopFoundingCustomerRenewalScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export default {
  startFoundingCustomerRenewalScheduler,
  stopFoundingCustomerRenewalScheduler,
  runFoundingCustomerRenewalsOnce
};
