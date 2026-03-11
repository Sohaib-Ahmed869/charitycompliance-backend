/**
 * Registration & Licenses reminder service
 *
 * - Scans registration/license documents (category: registration_license) for upcoming expiries
 * - Creates calendar reminder events and in-app notifications
 * - Recipients are resolved via Position module_permissions (charity_admin view/edit) + org owner
 */
import mongoose from 'mongoose';
import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { CalendarRepository } from '../repositories/calendarRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { logError, logInfo } from '../utils/logger.js';

const DEFAULT_DAYS_BEFORE = [60, 30, 14, 7, 1];

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const formatDate = (d) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: '2-digit' });
  } catch {
    return '—';
  }
};

/**
 * Resolve recipient user IDs based on configured positions/modules.
 * Strategy:
 * - Include org owner user
 * - Include users occupying positions that have module_permissions for charity_admin (view or edit)
 * - If org.settings.registration_license_reminders.position_ids is provided, only those positions are included
 */
async function resolveRecipients(tenantDb, orgObjectId, orgSettings = {}) {
  const userRepo = new UserRepository(tenantDb);
  const orgOwner = await userRepo.findOrgOwner();
  const ownerId = orgOwner?._id ? String(orgOwner._id) : null;

  const positionSchema = (await import('../db/schemas/platform/positionSchema.js')).default;
  const boardMemberSchema = (await import('../db/schemas/platform/boardMemberSchema.js')).default;
  tenantDb.models.Position || tenantDb.model('Position', positionSchema);
  tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
  const Position = tenantDb.model('Position');
  const BoardMember = tenantDb.model('BoardMember');

  const cfg = orgSettings?.registration_license_reminders || {};
  const restrictPositionIds = Array.isArray(cfg.position_ids) ? cfg.position_ids.filter(Boolean) : null;
  const moduleId = cfg.module_id || 'charity_admin';

  const positions = await Position.find({ org_id: orgObjectId, is_active: true }).select('_id module_permissions').lean();
  const allowedPositionIds = new Set();
  for (const p of positions) {
    const mps = Array.isArray(p.module_permissions) ? p.module_permissions : [];
    const mp = mps.find(x => String(x.module_id) === String(moduleId));
    if (mp?.view || mp?.edit) allowedPositionIds.add(String(p._id));
  }

  const effectiveAllowed = restrictPositionIds
    ? new Set(restrictPositionIds.map(String).filter((id) => allowedPositionIds.has(id)))
    : allowedPositionIds;

  const boardMembers = await BoardMember.find({ org_id: orgObjectId, status: { $ne: 'inactive' } })
    .select('user_id position_id')
    .lean();

  const recipients = new Set();
  if (ownerId) recipients.add(ownerId);
  for (const bm of boardMembers) {
    const pid = bm.position_id ? String(bm.position_id) : null;
    const uid = bm.user_id ? String(bm.user_id) : null;
    if (!pid || !uid) continue;
    if (effectiveAllowed.has(pid)) recipients.add(uid);
  }

  return Array.from(recipients);
}

async function getLeadTimes(orgSettings = {}) {
  const cfg = orgSettings?.registration_license_reminders || {};
  const days = Array.isArray(cfg.days_before) ? cfg.days_before.map(toInt).filter((n) => n != null && n >= 0) : null;
  return (days && days.length ? Array.from(new Set(days)).sort((a, b) => b - a) : DEFAULT_DAYS_BEFORE);
}

export async function runRegistrationLicenseRemindersOnce() {
  const routerDb = getRouterConnection();
  const tenants = await routerDb.collection('tenants').find({ status: 'active' }).project({ orgId: 1 }).toArray();

  const now = new Date();
  const today = startOfDay(now);

  let tenantCount = 0;
  let reminderCount = 0;

  for (const t of tenants) {
    const orgId = t?.orgId;
    if (!orgId) continue;
    tenantCount += 1;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const orgRepo = new OrganizationRepository(tenantDb);
      const org = await orgRepo.findOne();
      const orgObjectId = org?._id;
      if (!orgObjectId) continue;

      const orgSettings = org?.settings || {};
      const daysBeforeList = await getLeadTimes(orgSettings);
      const recipients = await resolveRecipients(tenantDb, orgObjectId, orgSettings);
      if (!recipients.length) continue;

      const calendarRepo = new CalendarRepository(tenantDb);
      const notificationRepo = new NotificationRepository(tenantDb);

      // Find docs expiring within max lead time
      const maxDays = Math.max(...daysBeforeList, 0);
      const end = new Date(today);
      end.setDate(end.getDate() + maxDays);

      const docSchema = (await import('../db/schemas/platform/documentSchema.js')).default;
      tenantDb.models.Document || tenantDb.model('Document', docSchema);
      const Document = tenantDb.model('Document');

      const docs = await Document.find({
        org_id: orgObjectId,
        category: 'registration_license',
        status: { $in: ['submitted', 'approved'] },
        expiry_date: { $exists: true, $ne: null, $gte: today, $lte: end }
      }).select('_id title document_type registration_number expiry_date').lean();

      for (const doc of docs) {
        const expiry = startOfDay(doc.expiry_date);
        const daysUntil = Math.round((expiry - today) / 86400000);
        if (!daysBeforeList.includes(daysUntil)) continue;

        const label = daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
        const title = `${doc.title || doc.document_type || 'Registration/License'} expires ${label}`;
        const msg = `${doc.document_type || 'Registration/License'}${doc.registration_number ? ` (${doc.registration_number})` : ''} expires on ${formatDate(doc.expiry_date)}.`;
        const link = `/charity-administration/registrations-licenses`;

        // Create a reminder event dated today (so it shows as a reminder before expiry)
        const eventDate = new Date(today);
        eventDate.setHours(9, 0, 0, 0);

        for (const uid of recipients) {
          // calendar reminder (deduped)
          await calendarRepo.upsertSystemReminderEvent({
            user_id: uid,
            source_id: doc._id,
            date: eventDate,
            title,
            description: msg,
            type: 'compliance'
          });

          // notification (deduped per-day)
          const already = await notificationRepo.existsToday({
            user_id: uid,
            type: 'registration_license_expiry_reminder',
            related_entity_id: doc._id,
            message_contains: `expires`
          });
          if (already) continue;

          await notificationRepo.create({
            user_id: uid,
            type: 'registration_license_expiry_reminder',
            title: 'Registration/License expiring',
            message: msg,
            link,
            related_entity_id: doc._id,
            related_entity_type: 'document',
            created_at: new Date()
          });
          reminderCount += 1;
        }
      }
    } catch (err) {
      logError('Registration/license reminder run failed for tenant', { orgId, error: err?.message });
    }
  }

  logInfo('Registration/license reminder run complete', { tenants: tenantCount, notificationsCreated: reminderCount });
  return { tenants: tenantCount, notificationsCreated: reminderCount };
}

/**
 * Start a lightweight scheduler (no external cron dependency).
 * Runs once per day at the specified local hour (default 08:00).
 */
export function startRegistrationLicenseReminderScheduler() {
  const enabled = String(process.env.REG_LICENSE_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;

  const targetHour = Number(process.env.REG_LICENSE_REMINDERS_HOUR || 8);
  let lastRunDate = null;

  const tick = async () => {
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    if (lastRunDate === todayKey) return;
    if (now.getHours() < targetHour) return;
    lastRunDate = todayKey;
    try {
      await runRegistrationLicenseRemindersOnce();
    } catch (err) {
      logError('Registration/license reminder scheduler tick failed', { error: err?.message });
    }
  };

  // check every 15 minutes
  setInterval(tick, 15 * 60 * 1000);
  // run soon after boot if time passed
  tick().catch(() => {});
}

