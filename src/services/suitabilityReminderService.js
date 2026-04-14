import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { logError, logInfo } from '../utils/logger.js';

const REQUIRED_TYPES = [
  'criminal_history_declaration',
  'bankruptcy_check',
  'disqualification_status',
  'conflict_of_interest',
  'fit_and_proper_check'
];

const computeStatus = (suitability = {}) => {
  const now = new Date();
  const items = Array.isArray(suitability?.items) ? suitability.items : [];
  const byType = new Map(items.map((item) => [item?.type, item]));
  if (Array.from(byType.values()).some((item) => item?.expires_at && new Date(item.expires_at) < now)) {
    return 'expired';
  }
  if (suitability?.next_review_date && new Date(suitability.next_review_date) < now) {
    return 'expired';
  }
  const allCompleted = REQUIRED_TYPES.every((type) => byType.get(type)?.completed === true);
  return allCompleted ? 'verified' : 'pending';
};

export async function runSuitabilityRenewalsOnce() {
  const routerDb = getRouterConnection();
  const tenants = await routerDb.collection('tenants').find({ status: 'active' }).project({ orgId: 1 }).toArray();
  let updatedCount = 0;
  for (const tenant of tenants) {
    const orgId = tenant?.orgId;
    if (!orgId) continue;
    try {
      const tenantDb = await getTenantConnection(orgId);
      tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
      const BoardMember = tenantDb.model('BoardMember');
      const notificationRepo = new NotificationRepository(tenantDb);
      const active = await BoardMember.find({ is_active: true }).select('_id given_names family_name user_id suitability_check').lean();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const MS_PER_DAY = 24 * 60 * 60 * 1000;
      for (const member of active) {
        const suitability = member?.suitability_check || {};
        const nextStatus = computeStatus(suitability);
        if (nextStatus !== suitability?.status) {
          await BoardMember.updateOne(
            { _id: member._id },
            { $set: { 'suitability_check.status': nextStatus } }
          );
          updatedCount += 1;
        }
        const reviewDate = suitability?.next_review_date ? new Date(suitability.next_review_date) : null;
        if (!member?.user_id || !reviewDate) continue;
        reviewDate.setHours(0, 0, 0, 0);
        const daysUntilReview = Math.ceil((reviewDate.getTime() - today.getTime()) / MS_PER_DAY);
        if (daysUntilReview > 30) continue;
        const isOverdue = daysUntilReview < 0;
        const type = isOverdue ? 'suitability_review_overdue' : 'suitability_review_due';
        const already = await notificationRepo.existsToday({
          user_id: String(member.user_id),
          type,
          related_entity_id: member._id,
          message_contains: 'suitability'
        });
        if (already) continue;
        await notificationRepo.create({
          user_id: String(member.user_id),
          type,
          title: isOverdue ? 'Suitability review overdue' : 'Suitability review due soon',
          message: `${member.given_names || ''} ${member.family_name || ''} suitability review is ${
            isOverdue ? 'overdue' : `due in ${daysUntilReview} day${daysUntilReview === 1 ? '' : 's'}`
          }.`,
          link: '/charity-administration/responsible-people',
          related_entity_id: member._id,
          related_entity_type: 'board_member',
          created_at: new Date()
        });
      }
    } catch (error) {
      logError('Suitability renewal tick failed for tenant', { orgId, error: error?.message });
    }
  }
  logInfo('Suitability renewal tick complete', { updatedCount });
  return { updatedCount };
}

export function startSuitabilityRenewalScheduler() {
  const enabled = String(process.env.SUITABILITY_RENEWALS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return;
  const targetHour = Number(process.env.SUITABILITY_RENEWALS_HOUR || 7);
  let lastRunDate = null;
  const tick = async () => {
    const now = new Date();
    const key = now.toISOString().slice(0, 10);
    if (lastRunDate === key) return;
    if (now.getHours() < targetHour) return;
    lastRunDate = key;
    try {
      await runSuitabilityRenewalsOnce();
    } catch (error) {
      logError('Suitability renewal scheduler failed', { error: error?.message });
    }
  };
  setInterval(tick, 15 * 60 * 1000);
  tick().catch(() => {});
}
