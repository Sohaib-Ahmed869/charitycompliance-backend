import mongoose from 'mongoose';
import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import assetSchema from '../db/schemas/platform/assetSchema.js';
import { logError, logInfo } from '../utils/logger.js';

const TICK_MS = Number(process.env.SUBSCRIPTION_MAINTENANCE_REMINDER_TICK_MS) || 30 * 24 * 60 * 60 * 1000;
const MAINTENANCE_WINDOW_DAYS = 30;
const MAINTENANCE_KEYS = ['backupVerified', 'softwareUpdated', 'accessReviewed', 'integrityChecked', 'securityAudit'];
const SUBSCRIPTION_CATEGORIES = ['Subscription', 'Software', 'Cloud Service'];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function computeMaintenanceStatus(checklist = {}) {
  const today = startOfDay(new Date());
  const overdueCutoff = new Date(today);
  overdueCutoff.setDate(overdueCutoff.getDate() - MAINTENANCE_WINDOW_DAYS);
  let overdueCount = 0;
  let completedCount = 0;
  MAINTENANCE_KEYS.forEach((key) => {
    const row = checklist?.[key] || {};
    const checkedAt = row.date ? startOfDay(new Date(row.date)) : null;
    const recent = checkedAt && checkedAt >= overdueCutoff;
    if (row.completed === true && recent) completedCount += 1;
    if (!recent) overdueCount += 1;
  });
  if (overdueCount > 0) return 'overdue';
  if (completedCount === MAINTENANCE_KEYS.length) return 'all_good';
  return 'attention';
}

async function listOrgIdsFromRouterDb() {
  const routerDb = await getRouterConnection();
  const orgs = await routerDb.collection('organizations').find({}).project({ org_id: 1 }).toArray();
  return (orgs || []).map((o) => String(o.org_id || '').trim()).filter(Boolean);
}

async function getRecipients(tenantDb, assignedTo) {
  const userRepo = new UserRepository(tenantDb);
  const owner = await userRepo.findOrgOwner();
  const recipients = new Set();
  if (owner?._id) recipients.add(String(owner._id));
  if (assignedTo && mongoose.Types.ObjectId.isValid(String(assignedTo))) {
    recipients.add(String(assignedTo));
  }
  return Array.from(recipients);
}

export async function runSubscriptionMaintenanceRemindersOnce() {
  const orgIds = await listOrgIdsFromRouterDb();
  for (const orgId of orgIds) {
    try {
      const tenantDb = await getTenantConnection(orgId);
      const Asset = tenantDb.models.Asset || tenantDb.model('Asset', assetSchema);
      const notificationRepo = new NotificationRepository(tenantDb);
      const rows = await Asset.find({
        category: { $in: SUBSCRIPTION_CATEGORIES },
        status: { $ne: 'retired' }
      }).select('_id asset_name assigned_to maintenanceChecklist').lean();

      for (const row of rows) {
        const status = computeMaintenanceStatus(row.maintenanceChecklist || {});
        if (status === 'all_good') continue;
        const recipients = await getRecipients(tenantDb, row.assigned_to);
        for (const uid of recipients) {
          const userId = mongoose.Types.ObjectId.isValid(uid) ? new mongoose.Types.ObjectId(uid) : null;
          if (!userId) continue;
          const already = await notificationRepo.existsToday({
            user_id: userId,
            type: 'it_subscription_maintenance_reminder',
            related_entity_id: row._id,
            message_contains: status
          });
          if (already) continue;
          await notificationRepo.create({
            user_id: userId,
            type: 'it_subscription_maintenance_reminder',
            title: 'Subscription maintenance checklist due',
            message: `[${status}] Complete monthly maintenance checks for "${row.asset_name || 'Subscription'}".`,
            link: '/assets',
            related_entity_id: row._id,
            related_entity_type: 'asset',
            created_at: new Date()
          });
        }
      }
    } catch (err) {
      logError('Subscription maintenance reminder run failed for org', { orgId, error: err?.message });
    }
  }
}

export function startSubscriptionMaintenanceReminderScheduler() {
  setInterval(() => {
    runSubscriptionMaintenanceRemindersOnce().catch((err) => {
      logError('Subscription maintenance reminder tick failed', err);
    });
  }, TICK_MS);
  logInfo('Subscription maintenance reminder scheduler started', { tickMs: TICK_MS });
}
