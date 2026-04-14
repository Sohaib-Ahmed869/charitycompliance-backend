/**
 * Deliver finance-related reminders through in-app notifications, email (if SMTP), and calendar (per user).
 */

import mongoose from 'mongoose';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { CalendarRepository } from '../repositories/calendarRepository.js';
import { logError, logInfo } from '../utils/logger.js';

export async function deliverFinanceReminder({
  tenantDb,
  recipients,
  notificationType,
  title,
  message,
  link,
  related_entity_id,
  related_entity_type,
  phaseTag,
  emailSubject,
  emailHtml,
  calendarTitle,
  calendarDescription,
  /** Date shown on the user's calendar for this reminder (typically "today" in UTC). */
  calendarDate,
  /** Optional distinct source for calendar upsert (e.g. period ObjectId). */
  calendarSourceId
}) {
  const notificationRepo = new NotificationRepository(tenantDb);
  const userRepo = new UserRepository(tenantDb);
  const calendarRepo = new CalendarRepository(tenantDb);
  const emailService = (await import('./emailService.js')).default;

  const day = calendarDate instanceof Date ? calendarDate : new Date(calendarDate);
  const calSrc =
    calendarSourceId && mongoose.Types.ObjectId.isValid(String(calendarSourceId))
      ? new mongoose.Types.ObjectId(String(calendarSourceId))
      : related_entity_id;

  let notifCount = 0;
  for (const uid of recipients) {
    if (!uid || !mongoose.Types.ObjectId.isValid(String(uid))) continue;
    const userOid = new mongoose.Types.ObjectId(String(uid));

    const already = await notificationRepo.existsToday({
      user_id: userOid,
      type: notificationType,
      related_entity_id,
      message_contains: phaseTag
    });
    if (already) continue;

    await notificationRepo.create({
      user_id: userOid,
      type: notificationType,
      title,
      message: `[${phaseTag}] ${message}`,
      link,
      related_entity_id,
      related_entity_type,
      created_at: new Date()
    });
    notifCount += 1;

    try {
      const user = await userRepo.findById(userOid);
      if (user?.email && emailSubject && emailHtml) {
        await emailService.sendComplianceReminderEmail({
          to: user.email,
          recipientName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'there',
          subject: emailSubject,
          html: emailHtml
        });
      }
    } catch (e) {
      logError('Finance reminder email failed', { uid, error: e?.message });
    }

    try {
      if (calendarTitle) {
        await calendarRepo.upsertSystemReminderEvent({
          user_id: userOid,
          source_id: calSrc,
          date: day,
          title: calendarTitle,
          description: calendarDescription || message,
          type: 'compliance',
          source: 'compliance'
        });
      }
    } catch (e) {
      logError('Finance reminder calendar upsert failed', { uid, error: e?.message });
    }
  }

  if (notifCount > 0) {
    logInfo('Finance reminders delivered', { type: notificationType, phaseTag, notifCount });
  }
}
