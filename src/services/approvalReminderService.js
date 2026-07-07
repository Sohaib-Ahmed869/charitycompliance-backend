/**
 * Approval reminder service
 *
 * Nudges approvers whose pending approval step has been sitting un-actioned.
 * Cadence is GLOBAL and super-admin configurable (Router DB reminder_configs,
 * reminder_type 'approval'): `offsets_hours` after a step becomes the current
 * pending step, capped by `max_reminders`.
 *
 * For each due offset it sends BOTH an in-app notification and a best-effort
 * mobile push (Expo). Mirrors the tenant-iteration structure of
 * registrationLicenseReminderService.js.
 */

import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { getApprovalReminderConfig } from '../repositories/reminderConfigRepository.js';
import { sendToUsers } from './pushService.js';
import { logError, logInfo } from '../utils/logger.js';

const HOUR_MS = 60 * 60 * 1000;

const humanizeRequestType = (t) =>
  String(t || 'request').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Indices of the step(s) currently awaiting a decision.
 *  - sequential: the first still-pending step.
 *  - parallel / any: every pending step.
 */
function computeActiveStepIndices(steps = [], approvalType = 'sequential') {
  const pending = [];
  for (let i = 0; i < steps.length; i++) {
    if ((steps[i]?.status || 'pending') === 'pending') pending.push(i);
  }
  if (!pending.length) return [];
  if (approvalType === 'parallel' || approvalType === 'any') return pending;
  return [pending[0]];
}

export async function runApprovalRemindersOnce() {
  const config = await getApprovalReminderConfig();
  if (!config || config.enabled === false) {
    logInfo('Approval reminders disabled — skipping run');
    return { tenants: 0, remindersCreated: 0, skipped: true };
  }

  const offsets = Array.from(
    new Set((config.offsets_hours || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))
  ).sort((a, b) => a - b);
  const maxReminders = Number.isFinite(config.max_reminders) ? config.max_reminders : 5;

  if (!offsets.length || maxReminders <= 0) {
    return { tenants: 0, remindersCreated: 0 };
  }

  const routerDb = getRouterConnection();
  const tenants = await routerDb.collection('tenants').find({ status: 'active' }).project({ orgId: 1 }).toArray();

  const now = new Date();
  let tenantCount = 0;
  let reminderCount = 0;

  for (const t of tenants) {
    const orgId = t?.orgId;
    if (!orgId) continue;
    tenantCount += 1;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const approvalRepo = new ApprovalRequestRepository(tenantDb);
      const notificationRepo = new NotificationRepository(tenantDb);
      const ApprovalRequest = approvalRepo.ApprovalRequest;

      // Pending requests that have at least one pending step already activated.
      const requests = await ApprovalRequest.find({
        status: 'pending',
        approval_steps: { $elemMatch: { status: 'pending', activated_at: { $ne: null } } }
      })
        .select('_id request_type approval_type approval_steps')
        .lean();

      for (const req of requests) {
        const steps = req.approval_steps || [];
        const activeIndices = computeActiveStepIndices(steps, req.approval_type);

        for (const idx of activeIndices) {
          const step = steps[idx];
          if (!step) continue;

          // Self-heal: a current step with no activation baseline gets one now,
          // so future ticks can measure elapsed time. Nothing is due yet.
          if (!step.activated_at) {
            await ApprovalRequest.collection.updateOne(
              { _id: req._id },
              { $set: { [`approval_steps.${idx}.activated_at`]: now } }
            ).catch(() => {});
            continue;
          }

          const approverUserId = step.approver_user_id ? String(step.approver_user_id) : null;
          // TODO: position/department-only steps (approver_user_id null) are not
          // resolved to concrete users here — no reminder is sent for them yet.
          if (!approverUserId) continue;

          const alreadySent = Array.isArray(step.reminders_sent)
            ? step.reminders_sent.map(Number)
            : [];
          const activatedAt = new Date(step.activated_at);

          const newlySent = [];
          for (const offset of offsets) {
            if (alreadySent.length + newlySent.length >= maxReminders) break;
            if (alreadySent.includes(offset) || newlySent.includes(offset)) continue;
            const dueAt = activatedAt.getTime() + offset * HOUR_MS;
            if (dueAt > now.getTime()) continue; // not due yet

            const requestId = String(req._id);
            const label = humanizeRequestType(req.request_type);

            // In-app notification.
            await notificationRepo.create({
              user_id: approverUserId,
              type: 'approval_pending',
              title: 'Approval still needs your review',
              message: `${label} approval is still awaiting your review.`,
              link: `/approvals/${requestId}`,
              related_entity_id: req._id,
              related_entity_type: 'approval_request',
              read: false,
              created_at: new Date()
            });

            // Best-effort mobile push (never throws).
            await sendToUsers(tenantDb, [approverUserId], {
              title: 'Approval still needs your review',
              body: label,
              data: { type: 'approval', id: requestId, screen: 'ApprovalDetail', params: { id: requestId } }
            });

            newlySent.push(offset);
            reminderCount += 1;
          }

          if (newlySent.length) {
            const merged = Array.from(new Set([...alreadySent, ...newlySent])).sort((a, b) => a - b);
            await ApprovalRequest.collection.updateOne(
              { _id: req._id },
              { $set: { [`approval_steps.${idx}.reminders_sent`]: merged } }
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      logError('Approval reminder run failed for tenant', { orgId, error: err?.message });
    }
  }

  logInfo('Approval reminder run complete', { tenants: tenantCount, remindersCreated: reminderCount });
  return { tenants: tenantCount, remindersCreated: reminderCount };
}

/**
 * Start a lightweight interval scheduler. Ticks every APPROVAL_REMINDER_TICK_MS
 * (default 30 min). Best-effort — a failed tick is logged, never fatal.
 */
export function startApprovalReminderScheduler() {
  const enabled = String(process.env.APPROVAL_REMINDERS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;

  const tickMs = Number(process.env.APPROVAL_REMINDER_TICK_MS) || 30 * 60 * 1000;

  const tick = async () => {
    try {
      await runApprovalRemindersOnce();
    } catch (err) {
      logError('Approval reminder scheduler tick failed', { error: err?.message });
    }
  };

  setInterval(tick, tickMs);
}

export default { runApprovalRemindersOnce, startApprovalReminderScheduler };
