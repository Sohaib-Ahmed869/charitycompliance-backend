/**
 * Meeting reminder service
 *
 * - Sends 1-hour-before reminders for upcoming meetings to all attendees.
 * - Uses the same lightweight scheduler pattern as registrationLicenseReminderService.
 */

import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import emailService from './emailService.js';
import { logError, logInfo } from '../utils/logger.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function runMeetingRemindersOnce() {
  const routerDb = getRouterConnection();
  const tenants = await routerDb
    .collection('tenants')
    .find({ status: 'active' })
    .project({ orgId: 1 })
    .toArray();

  const now = new Date();
  const windowStart = new Date(now.getTime() + ONE_HOUR_MS);
  const windowEnd = new Date(windowStart.getTime() + 10 * 60 * 1000); // 10-minute window

  let tenantCount = 0;
  let reminderCount = 0;

  for (const t of tenants) {
    const orgId = t?.orgId;
    if (!orgId) continue;
    tenantCount += 1;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const notificationRepo = new NotificationRepository(tenantDb);

      const meetingSchema = (await import('../db/schemas/platform/meetingSchema.js')).default;
      tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);
      const Meeting = tenantDb.model('Meeting');

      const meetings = await Meeting.find({
        date: { $gte: windowStart, $lte: windowEnd }
      })
        .select('_id title date attendees external_attendees meeting_type')
        .lean();

      if (!meetings.length) continue;

      const userRepo = new UserRepository(tenantDb);

      for (const m of meetings) {
        const when = new Date(m.date);
        const title = m.title || 'Meeting';
        const msg = `${title} starts at ${when.toLocaleTimeString('en-AU', {
          hour: '2-digit',
          minute: '2-digit'
        })}. This is a 1-hour reminder.`;
        const link = '/meetings';

        const attendeeUserIds = new Set();
        (m.attendees || []).forEach((a) => {
          if (a.user_id) attendeeUserIds.add(String(a.user_id));
        });

        const internalUsers = await userRepo.findManyByIds(Array.from(attendeeUserIds)).catch(() => []);

        for (const u of internalUsers || []) {
          const uid = String(u._id);
          const already = await notificationRepo.existsToday({
            user_id: uid,
            type: 'reminder_meeting',
            related_entity_id: m._id
          });
          if (already) continue;

          await notificationRepo.create({
            user_id: uid,
            type: 'reminder_meeting',
            title: 'Meeting starts in 1 hour',
            message: msg,
            link,
            related_entity_id: m._id,
            related_entity_type: 'meeting',
            created_at: new Date()
          });
          reminderCount += 1;

          if (u.email) {
            emailService.sendEmail({
              to: u.email,
              subject: `Reminder: ${title} starts in 1 hour`,
              text: msg,
              html: ''
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      logError('Meeting reminder run failed for tenant', { orgId, error: err?.message });
    }
  }

  logInfo('Meeting reminder run complete', { tenants: tenantCount, notificationsCreated: reminderCount });
  return { tenants: tenantCount, notificationsCreated: reminderCount };
}

/**
 * Start a lightweight scheduler for meeting reminders.
 * Runs every 10 minutes and sends a 1-hour-before reminder for upcoming meetings.
 */
export function startMeetingReminderScheduler() {
  const enabled = String(process.env.MEETING_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;

  const tick = async () => {
    try {
      await runMeetingRemindersOnce();
    } catch (err) {
      logError('Meeting reminder scheduler tick failed', { error: err?.message });
    }
  };

  // check every 10 minutes
  setInterval(tick, 10 * 60 * 1000);
  // run soon after boot
  tick().catch(() => {});
}

