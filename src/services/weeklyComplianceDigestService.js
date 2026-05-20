/**
 * Weekly compliance digest (REPORT-009 / REPORT-010).
 *
 * Sends a Monday-morning email to org owners summarising the previous
 * week's compliance state: open complaints, overdue checklist items,
 * pending approvals, upcoming meetings, recent submissions.
 *
 * Pattern follows the other reminder schedulers — daily tick, but the
 * actual send only happens once per ISO week (deduped via
 * notification.existsToday on a stable phase tag).
 */

import mongoose from 'mongoose';
import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import emailService from './emailService.js';
import { logError, logInfo } from '../utils/logger.js';

const TICK_MS = Number(process.env.WEEKLY_DIGEST_TICK_MS) || 24 * 60 * 60 * 1000;
const SEND_DAY_UTC = Number(process.env.WEEKLY_DIGEST_DOW_UTC ?? 1); // 1 = Monday
const ENABLED_DEFAULT = 'true';

function startOfWeekUtc(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay() === 0 ? 7 : x.getUTCDay();
  x.setUTCDate(x.getUTCDate() - (dow - 1));
  return x;
}

function weekTag(d) {
  const monday = startOfWeekUtc(d);
  return `digest-${monday.toISOString().slice(0, 10)}`;
}

async function listOrgIdsFromRouterDb() {
  const routerDb = await getRouterConnection();
  const orgs = await routerDb.collection('organizations').find({}).project({ org_id: 1 }).toArray();
  return (orgs || [])
    .map((o) => String(o.org_id || '').toLowerCase().trim())
    .filter(Boolean);
}

async function collectMetrics(tenantDb, orgObjectId) {
  // Each block is wrapped so a missing schema in a tenant doesn't take
  // down the whole digest run for that org.
  const out = {
    openComplaints: 0,
    overdueChecklistItems: 0,
    pendingApprovals: 0,
    upcomingMeetings: 0,
    newExpensesThisWeek: 0
  };

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const horizon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const today = new Date();

  try {
    const complaintSchema = (await import('../db/schemas/platform/complaintSchema.js')).default;
    tenantDb.models.Complaint || tenantDb.model('Complaint', complaintSchema);
    out.openComplaints = await tenantDb.model('Complaint').countDocuments({
      org_id: orgObjectId,
      status: { $nin: ['resolved', 'closed', 'archived'] }
    });
  } catch (_) {}

  try {
    const checklistInstanceSchema = (await import('../db/schemas/platform/checklistInstanceSchema.js')).default;
    tenantDb.models.ChecklistInstance || tenantDb.model('ChecklistInstance', checklistInstanceSchema);
    const Inst = tenantDb.model('ChecklistInstance');
    const rows = await Inst.aggregate([
      { $match: { org_id: orgObjectId } },
      { $unwind: '$items' },
      {
        $match: {
          'items.due_date': { $lt: today },
          'items.checked': { $ne: true }
        }
      },
      { $count: 'n' }
    ]);
    out.overdueChecklistItems = rows[0]?.n || 0;
  } catch (_) {}

  try {
    const approvalReqSchema = (await import('../db/schemas/platform/approvalRequestSchema.js')).default;
    tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalReqSchema);
    out.pendingApprovals = await tenantDb.model('ApprovalRequest').countDocuments({
      org_id: orgObjectId,
      status: { $in: ['pending', 'in_review', 'forwarded'] }
    });
  } catch (_) {}

  try {
    const meetingSchema = (await import('../db/schemas/platform/meetingSchema.js')).default;
    tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);
    out.upcomingMeetings = await tenantDb.model('Meeting').countDocuments({
      org_id: orgObjectId,
      meeting_date: { $gte: today, $lte: horizon },
      status: { $nin: ['cancelled', 'completed'] }
    });
  } catch (_) {}

  try {
    const expenseSchema = (await import('../db/schemas/platform/expenseSchema.js')).default;
    tenantDb.models.Expense || tenantDb.model('Expense', expenseSchema);
    out.newExpensesThisWeek = await tenantDb.model('Expense').countDocuments({
      org_id: orgObjectId,
      created_at: { $gte: weekAgo }
    });
  } catch (_) {}

  return out;
}

function renderDigestHtml(orgName, metrics, frontendBaseUrl) {
  const dash = `${frontendBaseUrl}/dashboard`;
  const row = (label, value, link) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eef1f4;color:#1f2933;">${label}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eef1f4;font-weight:600;color:#0b1220;text-align:right;">
        ${link ? `<a href="${link}" style="color:#2563eb;text-decoration:none;">${value}</a>` : value}
      </td>
    </tr>`;

  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2933;">
      <h2 style="margin:0 0 6px;">This week at ${String(orgName || 'your organisation').replace(/[<>]/g, '')}</h2>
      <p style="margin:0 0 18px;color:#5b6770;font-size:13px;">Weekly compliance digest — Stewardex</p>

      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
        ${row('Open complaints', metrics.openComplaints, `${frontendBaseUrl}/complaints`)}
        ${row('Overdue checklist items', metrics.overdueChecklistItems, `${frontendBaseUrl}/checklists`)}
        ${row('Pending approvals', metrics.pendingApprovals, `${frontendBaseUrl}/approvals`)}
        ${row('Upcoming meetings (next 14 days)', metrics.upcomingMeetings, `${frontendBaseUrl}/meetings`)}
        ${row('New expenses this week', metrics.newExpensesThisWeek, `${frontendBaseUrl}/financial-management`)}
      </table>

      <p style="margin:20px 0 0;font-size:13px;color:#5b6770;">
        Open the <a href="${dash}" style="color:#2563eb;text-decoration:none;">dashboard</a>
        for the full picture, or reply to this email if you have questions.
      </p>
    </div>
  `.trim();
}

async function sendDigestForOrg({ orgId, baseUrl }) {
  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org?._id) return { skipped: true, reason: 'no_org_doc' };

  const userRepo = new UserRepository(tenantDb);
  const owner = await userRepo.findOrgOwner();
  if (!owner?.email) return { skipped: true, reason: 'no_owner_email' };

  const notificationRepo = new NotificationRepository(tenantDb);
  const phase = weekTag(new Date());
  if (owner?._id) {
    const already = await notificationRepo.existsToday({
      user_id: new mongoose.Types.ObjectId(owner._id),
      type: 'weekly_compliance_digest',
      related_entity_id: org._id,
      message_contains: phase
    });
    if (already) return { skipped: true, reason: 'already_sent_this_week' };
  }

  const metrics = await collectMetrics(tenantDb, org._id);
  const html = renderDigestHtml(org.name || orgId, metrics, baseUrl);

  await emailService.sendEmail({
    to: owner.email,
    subject: `Stewardex weekly digest — ${org.name || orgId}`,
    html
  });

  if (owner?._id) {
    await notificationRepo.create({
      user_id: new mongoose.Types.ObjectId(owner._id),
      type: 'weekly_compliance_digest',
      title: 'Weekly compliance digest sent',
      message: `[${phase}] Digest emailed to ${owner.email}.`,
      link: '/dashboard',
      related_entity_id: org._id,
      related_entity_type: 'organization',
      created_at: new Date()
    });
  }

  return { sent: true };
}

export async function runWeeklyDigestOnce({ force = false } = {}) {
  const today = new Date();
  if (!force && today.getUTCDay() !== SEND_DAY_UTC) {
    return { skipped: true, reason: 'not_send_day' };
  }

  const orgIds = await listOrgIdsFromRouterDb();
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  let sent = 0;
  for (const orgId of orgIds) {
    try {
      const res = await sendDigestForOrg({ orgId, baseUrl });
      if (res?.sent) sent += 1;
    } catch (err) {
      logError('Weekly digest send failed', { orgId, error: err?.message });
    }
  }
  logInfo('Weekly compliance digest run complete', { orgCount: orgIds.length, sent });
  return { sent, orgCount: orgIds.length };
}

export function startWeeklyDigestScheduler() {
  const enabled = String(process.env.WEEKLY_DIGEST_ENABLED || ENABLED_DEFAULT).toLowerCase() !== 'false';
  if (!enabled) {
    logInfo('Weekly compliance digest disabled');
    return;
  }
  setInterval(() => {
    runWeeklyDigestOnce().catch((err) => logError('Weekly digest tick failed', err));
  }, TICK_MS);
  logInfo('Weekly compliance digest scheduler started', { tickMs: TICK_MS, sendDayUtc: SEND_DAY_UTC });
}
