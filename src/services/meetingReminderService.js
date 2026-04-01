/**
 * Meeting reminder service
 *
 * Sends ~1-hour and ~15-minute reminders using UTC `meeting.date`.
 * Uses a lookahead query + minute-based eligibility (not thin time windows) so a missed
 * scheduler tick still sends email/notifications ("catch-up") as long as the meeting
 * hasn't started and that phase wasn't already recorded for this start time.
 *
 * Phase order: 15m band runs before 1h so a meeting 30 minutes out gets a "soon" reminder,
 * not a stale "1 hour" line.
 *
 * Scheduler: MEETING_REMINDER_TICK_MS (default 3 minutes).
 */

import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import emailService from './emailService.js';
import { logError, logInfo } from '../utils/logger.js';

const MIN_MS = 60 * 1000;

/** Load candidate meetings starting within this many minutes (must cover 1h band + slack) */
const LOOKAHEAD_MINUTES = 115;

/**
 * 15m phase: meeting starts in (0, 36) minutes — catch-up if earlier ticks missed.
 * 1h phase uses >= 36 so there is no gap between bands.
 */
const PHASE_15M_MAX_MINUTES_BEFORE = 36;

/**
 * 1h phase: meeting starts in [36, 105] minutes — catch-up if the ideal ~1h window was missed.
 */
const PHASE_1H_MIN_MINUTES_BEFORE = 36;
const PHASE_1H_MAX_MINUTES_BEFORE = 105;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sameScheduledInstant(sentFor, meetingDate) {
  if (!sentFor || !meetingDate) return false;
  return Math.abs(new Date(sentFor).getTime() - new Date(meetingDate).getTime()) < 5000;
}

function formatWallTime(isoDate, timeZone) {
  const d = new Date(isoDate);
  const tz = timeZone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toUTCString();
  }
}

async function getOrgDisplayTimezone(tenantDb) {
  try {
    const organizationSchema = (await import('../db/schemas/platform/organizationSchema.js')).default;
    tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
    const org = await tenantDb.model('Organization').findOne().select('timezone').lean();
    if (org?.timezone) return org.timezone;
  } catch {
    /* ignore */
  }
  return process.env.REMINDER_DISPLAY_TIMEZONE || 'UTC';
}

function minutesUntilStart(meetingDate, now) {
  return (new Date(meetingDate).getTime() - now.getTime()) / MIN_MS;
}

/**
 * @param {'1h' | '15m'} phase
 */
async function sendMeetingReminderForMeeting({
  Meeting,
  m,
  phase,
  notificationRepo,
  userRepo,
  displayTz,
  now,
  orgId,
}) {
  const is1h = phase === '1h';
  const tag = is1h ? '[reminder:1h]' : '[reminder:15m]';
  const meetingDate = m.date;
  const minutesUntil = Math.max(1, Math.round(minutesUntilStart(meetingDate, now)));

  const title = m.title || 'Meeting';
  const wall = formatWallTime(meetingDate, displayTz);
  const msg = `${title} starts in about ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'} (${wall}, organisation calendar). ${tag}`;
  const link = '/meetings';

  const attendeeUserIds = new Set();
  (m.attendees || []).forEach((a) => {
    if (a.user_id) attendeeUserIds.add(String(a.user_id));
  });

  const internalUsers = await userRepo.findManyByIds(Array.from(attendeeUserIds)).catch(() => []);

  const emailPromises = [];
  let notificationsCreated = 0;

  for (const u of internalUsers || []) {
    const uid = String(u._id);
    const already = await notificationRepo.existsToday({
      user_id: uid,
      type: 'reminder_meeting',
      related_entity_id: m._id,
      message_contains: tag,
    });
    if (already) continue;

    await notificationRepo.create({
      user_id: uid,
      type: 'reminder_meeting',
      title: is1h ? 'Meeting in about 1 hour' : 'Meeting starting soon',
      message: msg,
      link,
      related_entity_id: m._id,
      related_entity_type: 'meeting',
      created_at: new Date(),
    });
    notificationsCreated += 1;

    if (u.email) {
      emailPromises.push(
        emailService
          .sendEmail({
            to: u.email,
            subject: `Reminder: ${title} in about ${minutesUntil} minutes`,
            text: `${title} starts in about ${minutesUntil} minutes. Organisation calendar (${displayTz}): ${wall}.`,
            html: emailService.buildBrandedHtml({
              heading: 'Meeting reminder',
              bodyHtml: `
                <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
                  <strong>${escapeHtml(title)}</strong> starts in about <strong>${minutesUntil}</strong> minutes.
                </p>
                <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
                  Organisation calendar (${escapeHtml(displayTz)}): ${escapeHtml(wall)}
                </p>
              `,
              buttonText: 'View meeting',
              buttonLink: link,
              infoBoxLines: ['If you cannot access the meeting link, please contact your administrator.']
            })
          })
          .catch((err) => {
            logError('Meeting reminder email failed', { orgId, to: u.email, phase, error: err?.message });
          })
      );
    }
  }

  for (const ext of m.external_attendees || []) {
    if (!ext.email) continue;
    emailPromises.push(
      emailService
        .sendEmail({
          to: ext.email,
          subject: `Reminder: ${title} in about ${minutesUntil} minutes`,
          text: `${title} starts in about ${minutesUntil} minutes. Organisation calendar: ${wall}.`,
          html: emailService.buildBrandedHtml({
            heading: 'Meeting reminder',
            bodyHtml: `
              <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
                <strong>${escapeHtml(title)}</strong> starts in about <strong>${minutesUntil}</strong> minutes.
              </p>
              <p style="margin: 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
                Organisation calendar: ${escapeHtml(wall)}
              </p>
            `,
            buttonText: 'View meeting',
            buttonLink: link,
            infoBoxLines: ['This is an automated reminder.']
          })
        })
        .catch((err) => {
          logError('Meeting reminder email failed (external)', {
            orgId,
            to: ext.email,
            phase,
            error: err?.message,
          });
        })
    );
  }

  await Promise.all(emailPromises);

  const setPath = is1h
    ? { 'reminder_sent.one_hour_for_date': meetingDate }
    : { 'reminder_sent.fifteen_min_for_date': meetingDate };
  await Meeting.updateOne({ _id: m._id }, { $set: setPath });

  return notificationsCreated;
}

async function processTenantMeetingReminders({
  orgId,
  Meeting,
  notificationRepo,
  userRepo,
  displayTz,
  now,
}) {
  const horizon = new Date(now.getTime() + LOOKAHEAD_MINUTES * MIN_MS);

  const rawMeetings = await Meeting.find({
    date: { $gt: now, $lte: horizon },
    status: { $nin: ['cancelled', 'completed'] },
  })
    .select('_id title date attendees external_attendees reminder_sent status')
    .lean();

  let notificationsCreated = 0;

  /** 15m first: "starting soon" for anything within 35 minutes */
  for (const m of rawMeetings) {
    const mu = minutesUntilStart(m.date, now);
    if (mu <= 0 || mu >= PHASE_15M_MAX_MINUTES_BEFORE) continue;
    if (sameScheduledInstant(m.reminder_sent?.fifteen_min_for_date, m.date)) continue;

    notificationsCreated += await sendMeetingReminderForMeeting({
      Meeting,
      m,
      phase: '15m',
      notificationRepo,
      userRepo,
      displayTz,
      now,
      orgId,
    });
  }

  /** 1h: only if far enough out that we didn't already cover with 15m catch-up band */
  for (const m of rawMeetings) {
    const mu = minutesUntilStart(m.date, now);
    if (mu < PHASE_1H_MIN_MINUTES_BEFORE || mu > PHASE_1H_MAX_MINUTES_BEFORE) continue;
    if (sameScheduledInstant(m.reminder_sent?.one_hour_for_date, m.date)) continue;

    notificationsCreated += await sendMeetingReminderForMeeting({
      Meeting,
      m,
      phase: '1h',
      notificationRepo,
      userRepo,
      displayTz,
      now,
      orgId,
    });
  }

  return { notificationsCreated, scanned: rawMeetings.length };
}

export async function runMeetingRemindersOnce() {
  const routerDb = getRouterConnection();
  const tenants = await routerDb
    .collection('tenants')
    .find({ status: 'active' })
    .project({ orgId: 1 })
    .toArray();

  const now = new Date();
  let tenantCount = 0;
  let reminderCount = 0;
  let meetingsScanned = 0;

  for (const t of tenants) {
    const orgId = t?.orgId;
    if (!orgId) continue;
    tenantCount += 1;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const notificationRepo = new NotificationRepository(tenantDb);
      const userRepo = new UserRepository(tenantDb);

      const meetingSchema = (await import('../db/schemas/platform/meetingSchema.js')).default;
      tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);
      const Meeting = tenantDb.model('Meeting');

      const displayTz = await getOrgDisplayTimezone(tenantDb);

      const { notificationsCreated, scanned } = await processTenantMeetingReminders({
        orgId,
        Meeting,
        notificationRepo,
        userRepo,
        displayTz,
        now,
      });
      reminderCount += notificationsCreated;
      meetingsScanned += scanned;
    } catch (err) {
      logError('Meeting reminder run failed for tenant', { orgId, error: err?.message });
    }
  }

  logInfo('Meeting reminder run complete', {
    tenants: tenantCount,
    notificationsCreated: reminderCount,
    meetingsInReminderHorizon: meetingsScanned,
  });
  return { tenants: tenantCount, notificationsCreated: reminderCount, meetingsInReminderHorizon: meetingsScanned };
}

/**
 * Start scheduler. Default tick 3 minutes (override MEETING_REMINDER_TICK_MS).
 */
export function startMeetingReminderScheduler() {
  const enabled = String(process.env.MEETING_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;

  const tickMs = Number(process.env.MEETING_REMINDER_TICK_MS) || 3 * 60 * 1000;

  const tick = async () => {
    try {
      await runMeetingRemindersOnce();
    } catch (err) {
      logError('Meeting reminder scheduler tick failed', { error: err?.message });
    }
  };

  setInterval(tick, tickMs);
  tick().catch(() => {});
}
