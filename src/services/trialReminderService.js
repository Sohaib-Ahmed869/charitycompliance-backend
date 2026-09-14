/**
 * Trial-ending reminder scheduler.
 *
 * Once an hour (configurable), sweeps OrganizationSubscription for tenants
 * whose trial ends in 3 days (or whatever TRIAL_REMINDER_DAYS is set to)
 * and emails the org owner via sendTrialEnding.
 *
 * Idempotent — uses a `trial_reminder_sent_for` field on the subscription
 * to record which period_end we've already nudged for, so a tenant gets
 * exactly one reminder per trial.
 */

import getRouterModels from '../db/models/routerModels.js';
import { sendTrialEnding } from './billingEmails.js';
import { getOrgOwnerEmail } from '../utils/getOrgOwnerEmail.js';
import { logError, logInfo } from '../utils/logger.js';

const REMINDER_DAYS = Number(process.env.TRIAL_REMINDER_DAYS || 3);

/** One sweep — exported for boot-time catch-up + manual ops. */
export async function runTrialRemindersOnce() {
  const { OrganizationSubscription, SubscriptionPlan } = getRouterModels();

  // Window: trials ending between now and now+REMINDER_DAYS days (inclusive).
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_DAYS * 24 * 60 * 60 * 1000);

  const trialSubs = await OrganizationSubscription.find({
    status: 'trialing',
    current_period_end: { $gte: now, $lte: windowEnd }
  });

  let sent = 0;
  for (const sub of trialSubs) {
    const periodEndKey = sub.current_period_end?.toISOString();
    // Skip if we've already nudged for this exact trial end.
    if (sub.trial_reminder_sent_for === periodEndKey) continue;

    try {
      const ownerEmail = await getOrgOwnerEmail(sub.organization_id).catch(() => null);
      if (!ownerEmail) continue;

      const plan = sub.plan_id ? await SubscriptionPlan.findById(sub.plan_id).lean() : null;
      const daysLeft = Math.max(0, Math.ceil((sub.current_period_end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

      await sendTrialEnding({
        to: ownerEmail,
        orgName: sub.organization_id,
        planName: plan?.plan_name || 'your plan',
        amountAUD: sub.billing_cycle === 'yearly' ? plan?.pricing?.annualAUD : plan?.pricing?.monthlyAUD,
        billingCycle: sub.billing_cycle,
        periodEndAt: sub.current_period_end,
        daysLeft
      });

      sub.trial_reminder_sent_for = periodEndKey;
      await sub.save();
      sent += 1;
    } catch (err) {
      logError(`Trial reminder failed for ${sub.organization_id}`, err);
    }
  }

  if (sent > 0) logInfo(`[trialReminder] sent ${sent} trial-ending reminder(s)`);
  return { swept: trialSubs.length, sent };
}

/** Start the scheduler — fires immediately on boot, then every hour. */
export function startTrialReminderScheduler() {
  const enabled = String(process.env.TRIAL_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;

  const tickMs = Number(process.env.TRIAL_REMINDER_TICK_MS) || 60 * 60 * 1000; // hourly

  const tick = async () => {
    try {
      await runTrialRemindersOnce();
    } catch (err) {
      logError('Trial reminder scheduler tick failed', err);
    }
  };

  setInterval(tick, tickMs);
  // Boot-time sweep — picks up any trials that ended overnight.
  tick().catch(() => {});
}
