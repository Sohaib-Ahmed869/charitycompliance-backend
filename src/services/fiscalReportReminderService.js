/**
 * Fiscal report due reminders (monthly + Australian financial year yearly).
 *
 * Reminder points (UTC calendar days) for each open period:
 * - Day 15 of the due month (monthly: report month; yearly: June)
 * - 7 days before due_date
 * - 1 day before due_date
 *
 * Recipients: org owner + users in positions with financial_mgmt module view/edit.
 * Deduped via NotificationRepository.existsToday.
 */

import mongoose from 'mongoose';
import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { logError, logInfo } from '../utils/logger.js';

const TICK_MS = Number(process.env.FISCAL_REPORT_REMINDER_TICK_MS) || 24 * 60 * 60 * 1000;

function startOfDayUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addDaysUtc(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function lastDayOfMonthUtc(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0, 23, 59, 59, 999));
}

/** Australian FY ends 30 June of `endYear` (e.g. endYear 2026 → FY ending Jun 2026). */
function financialYearEndYearFromDate(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return m >= 7 ? y + 1 : y;
}

async function listOrgIdsFromRouterDb() {
  const routerDb = await getRouterConnection();
  const orgs = await routerDb.collection('organizations').find({}).project({ org_id: 1 }).toArray();
  return (orgs || [])
    .map((o) => String(o.org_id || '').toLowerCase().trim())
    .filter(Boolean);
}

async function resolveFinancialRecipients(tenantDb, orgObjectId) {
  const userRepo = new UserRepository(tenantDb);
  const orgOwner = await userRepo.findOrgOwner();
  const ownerId = orgOwner?._id ? String(orgOwner._id) : null;

  const positionSchema = (await import('../db/schemas/platform/positionSchema.js')).default;
  tenantDb.models.Position || tenantDb.model('Position', positionSchema);
  const Position = tenantDb.model('Position');

  const positions = await Position.find({ org_id: orgObjectId, is_active: true }).select('_id module_permissions').lean();
  const allowedPositionIds = new Set();
  for (const p of positions) {
    const mps = Array.isArray(p.module_permissions) ? p.module_permissions : [];
    const mp = mps.find((x) => String(x.module_id) === 'financial_mgmt');
    if (mp?.view || mp?.edit) allowedPositionIds.add(String(p._id));
  }

  const userPositionSchema = (await import('../db/schemas/platform/userPositionSchema.js')).default;
  tenantDb.models.UserPosition || tenantDb.model('UserPosition', userPositionSchema);
  const UserPosition = tenantDb.model('UserPosition');

  const recipients = new Set();
  if (ownerId) recipients.add(ownerId);
  for (const pid of allowedPositionIds) {
    const posOid = mongoose.Types.ObjectId.isValid(pid) ? new mongoose.Types.ObjectId(pid) : null;
    if (!posOid) continue;
    const ups = await UserPosition.find({ org_id: orgObjectId, position_id: posOid, is_active: true }).select('user_id').lean();
    for (const up of ups) {
      if (up?.user_id) recipients.add(String(up.user_id));
    }
  }
  return Array.from(recipients);
}

async function periodStillOpen(tenantDb, orgObjectId, periodKey) {
  const documentSchema = (await import('../db/schemas/platform/documentSchema.js')).default;
  tenantDb.models.Document || tenantDb.model('Document', documentSchema);
  const Document = tenantDb.model('Document');
  const found = await Document.findOne({
    org_id: orgObjectId,
    category: 'fiscal_report',
    'metadata.period_key': periodKey,
    status: { $in: ['submitted', 'review_pending', 'approved'] }
  })
    .select('_id')
    .lean();
  return !found;
}

function reminderPhaseForDate(today, dueDate) {
  const t0 = startOfDayUtc(today);
  const due0 = startOfDayUtc(dueDate);
  const d7 = addDaysUtc(due0, -7);
  const d1 = addDaysUtc(due0, -1);
  if (t0.getTime() === startOfDayUtc(d7).getTime()) return 'due_in_7_days';
  if (t0.getTime() === startOfDayUtc(d1).getTime()) return 'due_in_1_day';
  if (
    t0.getUTCFullYear() === due0.getUTCFullYear() &&
    t0.getUTCMonth() === due0.getUTCMonth() &&
    t0.getUTCDate() === 15
  ) {
    return 'mid_month_15';
  }
  return null;
}

async function notifyRecipients({
  tenantDb,
  orgId,
  recipients,
  title,
  message,
  link,
  relatedId,
  phaseTag
}) {
  const notificationRepo = new NotificationRepository(tenantDb);
  let count = 0;
  for (const uid of recipients) {
    const already = await notificationRepo.existsToday({
      user_id: new mongoose.Types.ObjectId(uid),
      type: 'fiscal_report_reminder',
      related_entity_id: relatedId,
      message_contains: phaseTag
    });
    if (already) continue;
    await notificationRepo.create({
      user_id: new mongoose.Types.ObjectId(uid),
      type: 'fiscal_report_reminder',
      title,
      message: `[${phaseTag}] ${message}`,
      link,
      related_entity_id: relatedId,
      related_entity_type: 'fiscal_report_period',
      created_at: new Date()
    });
    count += 1;
  }
  if (count > 0) {
    logInfo('Fiscal report reminders sent', { orgId, phaseTag, count });
  }
}

export async function runFiscalReportRemindersOnce() {
  const orgIds = await listOrgIdsFromRouterDb();
  const now = new Date();
  const today = startOfDayUtc(now);

  for (const orgId of orgIds) {
    try {
      const tenantDb = await getTenantConnection(orgId);
      const orgRepo = new OrganizationRepository(tenantDb);
      const org = await orgRepo.findOne();
      if (!org?._id) continue;

      const recipients = await resolveFinancialRecipients(tenantDb, org._id);
      if (!recipients.length) continue;

      const y = today.getUTCFullYear();
      const m = today.getUTCMonth() + 1;
      const monthlyDue = lastDayOfMonthUtc(y, m);
      const monthlyKey = `${y}-${String(m).padStart(2, '0')}`;
      if (await periodStillOpen(tenantDb, org._id, monthlyKey)) {
        const phase = reminderPhaseForDate(today, monthlyDue);
        if (phase) {
          await notifyRecipients({
            tenantDb,
            orgId,
            recipients,
            title: 'Monthly fiscal report due',
            message: `Upload the monthly fiscal report for ${monthlyKey} (${phase.replace(/_/g, ' ')}). Due ${monthlyDue.toISOString().slice(0, 10)} (UTC).`,
            link: '/finance/fiscal-reports',
            relatedId: org._id,
            phaseTag: `${monthlyKey}-${phase}`
          });
        }
      }

      const fyEndYear = financialYearEndYearFromDate(today);
      const yearlyDue = new Date(Date.UTC(fyEndYear, 5, 30, 23, 59, 59, 999));
      const yearlyKey = `FY-${fyEndYear}`;
      if (await periodStillOpen(tenantDb, org._id, yearlyKey)) {
        const phase = reminderPhaseForDate(today, yearlyDue);
        if (phase) {
          await notifyRecipients({
            tenantDb,
            orgId,
            recipients,
            title: 'Annual fiscal report due (financial year)',
            message: `Upload the yearly fiscal report for FY ending 30 June ${fyEndYear} (${phase.replace(/_/g, ' ')}).`,
            link: '/finance/fiscal-reports',
            relatedId: org._id,
            phaseTag: `${yearlyKey}-${phase}`
          });
        }
      }
    } catch (err) {
      logError('Fiscal report reminder run failed for org', { orgId, error: err?.message });
    }
  }
}

export function startFiscalReportReminderScheduler() {
  const enabled = String(process.env.FISCAL_REPORT_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logInfo('Fiscal report reminder scheduler disabled');
    return;
  }

  setInterval(() => {
    runFiscalReportRemindersOnce().catch((err) => logError('Fiscal report reminder tick failed', err));
  }, TICK_MS);
  logInfo('Fiscal report reminder scheduler started', { tickMs: TICK_MS });
}
