/**
 * Registration & Licenses reminder service
 *
 * - Scans registration/license documents (category: registration_license) for upcoming expiries
 * - Creates calendar reminder events and in-app notifications
 * - Recipients are resolved via Position module_permissions (charity_admin view/edit) + org owner
 */
import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { CalendarRepository } from '../repositories/calendarRepository.js';
import { NotificationRepository } from '../repositories/notificationRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import emailService from './emailService.js';
import { logError, logInfo } from '../utils/logger.js';

const DEFAULT_DAYS_BEFORE = [60, 30, 14, 7, 3, 1];
const ESCALATION_HOD_DAYS_OVERDUE = 1;
const ESCALATION_BOARD_DAYS_AFTER_HOD = 7;

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

const toTitleCase = (v) =>
  String(v || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

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

async function resolveBoardUserIds(tenantDb, orgObjectId) {
  const bmRepo = new BoardMemberRepository(tenantDb);
  const boardMembers = await bmRepo.findByOrgId(orgObjectId, false, false);
  return (Array.isArray(boardMembers) ? boardMembers : [])
    .filter((bm) => bm?.is_board_member === true && bm?.has_system_access !== false && bm?.user_id)
    .map((bm) => String(bm.user_id));
}

async function resolveHodUserIdForDepartment(tenantDb, orgObjectId, departmentId) {
  const bmRepo = new BoardMemberRepository(tenantDb);
  const hod = await bmRepo.findDepartmentHeadByDepartmentId(orgObjectId, departmentId);
  return hod?.user_id ? String(hod.user_id) : null;
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

      const userRepo = new UserRepository(tenantDb);
      const calendarRepo = new CalendarRepository(tenantDb);
      const notificationRepo = new NotificationRepository(tenantDb);
      const boardUserIds = await resolveBoardUserIds(tenantDb, orgObjectId).catch(() => []);

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
      }).select('_id title document_type registration_number expiry_date uploaded_by').lean();

      for (const doc of docs) {
        const expiry = startOfDay(doc.expiry_date);
        const daysUntil = Math.round((expiry - today) / 86400000);
        if (!daysBeforeList.includes(daysUntil)) continue;

        const label = daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
        const title = `${doc.title || doc.document_type || 'Registration/License'} expires ${label}`;
        const docType = toTitleCase(doc.document_type || 'Registration/License');
        const msg = `${docType}${doc.registration_number ? ` (${doc.registration_number})` : ''} expires on ${formatDate(doc.expiry_date)}.`;
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
          const u = await userRepo.findById(uid).catch(() => null);
          if (u?.email) {
            emailService
              .sendEmail({
                to: u.email,
                subject: title,
                text: msg,
                html: emailService.buildBrandedHtml({
                  heading: 'Expiry reminder',
                  bodyHtml: `
                    <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
                      ${msg}
                    </p>
                  `,
                  buttonText: 'View register',
                  buttonLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}${link}`,
                  infoBoxLines: ['Please renew or update the record before it expires.']
                })
              })
              .catch(() => {});
            logInfo('Reminder email sent (registration/license)', {
              orgId,
              userId: String(uid),
              documentId: String(doc._id)
            });
          }
        }
      }

      // ── Escalations for overdue registrations/licenses (HOD after 1 day, Board after 7 more days) ──
      // We treat "action not taken" as: item is past due and still present in active statuses.
      // We only look back enough days to cover the escalation windows.
      const overdueLookbackDays = ESCALATION_HOD_DAYS_OVERDUE + ESCALATION_BOARD_DAYS_AFTER_HOD + 1; // e.g. 9
      const overdueStart = new Date(today);
      overdueStart.setDate(overdueStart.getDate() - overdueLookbackDays);
      const overdueLicenses = await Document.find({
        org_id: orgObjectId,
        category: 'registration_license',
        status: { $in: ['submitted', 'approved'] },
        expiry_date: { $exists: true, $ne: null, $gte: overdueStart, $lt: today }
      }).select('_id title document_type registration_number expiry_date uploaded_by').lean();

      for (const doc of overdueLicenses) {
        const due = startOfDay(doc.expiry_date);
        const daysUntil = Math.round((due - today) / 86400000); // negative when overdue
        const daysOverdue = -daysUntil;
        const docType = toTitleCase(doc.document_type || 'Registration/License');
        const baseTitle = doc.title || doc.document_type || 'Registration/License';
        const link = `/charity-administration/registrations-licenses`;

        // Notify responsible person (uploader) at 7d & 3d before expiry as well (in addition to general recipients).
        if ([7, 3].includes(Math.max(daysUntil, 0))) {
          const responsibleUid = doc.uploaded_by ? String(doc.uploaded_by) : null;
          if (responsibleUid) {
            const already = await notificationRepo.existsToday({
              user_id: responsibleUid,
              type: 'compliance_due_reminder',
              related_entity_id: doc._id,
              message_contains: '[stage:responsible]'
            });
            if (!already) {
              const label = `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
              const msg = `${docType}${doc.registration_number ? ` (${doc.registration_number})` : ''} expires on ${formatDate(doc.expiry_date)}.`;
              await notificationRepo.create({
                user_id: responsibleUid,
                type: 'compliance_due_reminder',
                title: `${baseTitle} due ${label}`,
                message: `${msg} [stage:responsible]`,
                link,
                related_entity_id: doc._id,
                related_entity_type: 'document',
                created_at: new Date()
              });
              reminderCount += 1;
            }
          }
        }

        // Escalate to HOD after 1 day overdue.
        if (daysOverdue === ESCALATION_HOD_DAYS_OVERDUE) {
          // No department mapping for licenses; use org owner (already in recipients) as HOD fallback.
          const hodUid = recipients[0] || null;
          if (hodUid) {
            const already = await notificationRepo.existsToday({
              user_id: hodUid,
              type: 'compliance_overdue_hod',
              related_entity_id: doc._id,
              message_contains: '[stage:hod]'
            });
            if (!already) {
              const msg = `${docType}${doc.registration_number ? ` (${doc.registration_number})` : ''} expired on ${formatDate(doc.expiry_date)} and has not been updated.`;
              await notificationRepo.create({
                user_id: hodUid,
                type: 'compliance_overdue_hod',
                title: `Overdue: ${baseTitle}`,
                message: `${msg} [stage:hod]`,
                link,
                related_entity_id: doc._id,
                related_entity_type: 'document',
                created_at: new Date()
              });
              reminderCount += 1;
              const u = await userRepo.findById(hodUid).catch(() => null);
              if (u?.email) {
                emailService.sendEmail({
                  to: u.email,
                  subject: `Overdue action required: ${baseTitle}`,
                  text: msg,
                  html: emailService.buildBrandedHtml({
                    heading: 'Overdue compliance item',
                    bodyHtml: `<p style="margin:0;font-size:12px;line-height:18px;color:#333333;text-align:center;max-width:500px;">${msg}</p>`,
                    buttonText: 'View register',
                    buttonLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}${link}`,
                    infoBoxLines: ['Escalated because no action was taken after the due date.']
                  })
                }).catch(() => {});
              }
            }
          }
        }

        // Escalate to Board 7 days after HOD escalation (i.e. 8 days overdue by default).
        if (daysOverdue === (ESCALATION_HOD_DAYS_OVERDUE + ESCALATION_BOARD_DAYS_AFTER_HOD)) {
          for (const boardUid of boardUserIds) {
            const already = await notificationRepo.existsToday({
              user_id: boardUid,
              type: 'compliance_overdue_board',
              related_entity_id: doc._id,
              message_contains: '[stage:board]'
            });
            if (already) continue;
            const msg = `${docType}${doc.registration_number ? ` (${doc.registration_number})` : ''} expired on ${formatDate(doc.expiry_date)} and remains unaddressed after escalation.`;
            await notificationRepo.create({
              user_id: boardUid,
              type: 'compliance_overdue_board',
              title: `Board escalation: ${baseTitle}`,
              message: `${msg} [stage:board]`,
              link,
              related_entity_id: doc._id,
              related_entity_type: 'document',
              created_at: new Date()
            });
            reminderCount += 1;
          }
        }
      }

      // ── Governing documents & key policies — review reminders ──────────────
      const govCategories = ['governing_document', 'constitution', 'trust_deed', 'document_approval'];
      const govDocs = await Document.find({
        org_id: orgObjectId,
        category: { $in: govCategories },
        status: { $in: ['submitted', 'review_pending', 'approved'] },
        review_date: { $exists: true, $ne: null, $gte: today, $lte: end }
      }).select('_id title document_type review_date').lean();

      for (const doc of govDocs) {
        const review = startOfDay(doc.review_date);
        const daysUntil = Math.round((review - today) / 86400000);
        if (!daysBeforeList.includes(daysUntil)) continue;

        const label = daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
        const title = `${doc.title || doc.document_type || 'Governing document'} review due ${label}`;
        const docType = toTitleCase(doc.document_type || 'Governing document');
        const msg = `${docType} should be reviewed by ${formatDate(doc.review_date)}.`;
        const link = '/governance/governing-documents';

        const eventDate = new Date(today);
        eventDate.setHours(9, 0, 0, 0);

        for (const uid of recipients) {
          await calendarRepo.upsertSystemReminderEvent({
            user_id: uid,
            source_id: doc._id,
            date: eventDate,
            title,
            description: msg,
            type: 'compliance'
          });

          const already = await notificationRepo.existsToday({
            user_id: uid,
            type: 'reminder_expiring',
            related_entity_id: doc._id,
            message_contains: 'review'
          });
          if (already) continue;

          await notificationRepo.create({
            user_id: uid,
            type: 'reminder_expiring',
            title: 'Governing document review due',
            message: msg,
            link,
            related_entity_id: doc._id,
            related_entity_type: 'document',
            created_at: new Date()
          });
          reminderCount += 1;
          const u = await userRepo.findById(uid).catch(() => null);
          if (u?.email) {
            emailService
              .sendEmail({
                to: u.email,
                subject: title,
                text: msg,
                html: emailService.buildBrandedHtml({
                  heading: 'Review reminder',
                  bodyHtml: `
                    <p style="margin: 0 0 12px 0; font-size: 12px; line-height: 18px; color: #333333; font-weight: 400; text-align: center; max-width: 500px;">
                      ${msg}
                    </p>
                  `,
                  buttonText: 'View documents',
                  buttonLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}${link}`,
                  infoBoxLines: ['This is an automated compliance reminder.']
                })
              })
              .catch(() => {});
            logInfo('Reminder email sent (governing document review)', {
              orgId,
              userId: String(uid),
              documentId: String(doc._id)
            });
          }
        }
      }

      // ── Risk treatment due dates ────────────────────────────────────────────
      const riskSchema = (await import('../db/schemas/platform/riskSchema.js')).default;
      tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);
      const Risk = tenantDb.model('Risk');

      const risks = await Risk.find({
        org_id: orgObjectId,
        status: { $in: ['pending', 'under_treatment', 'approved'] },
        'treatments.due_date': { $exists: true, $ne: null, $gte: today, $lte: end }
      })
        .select('_id title risk_title submitted_by treatments')
        .lean();

      for (const risk of risks) {
        const submitterId = risk.submitted_by ? String(risk.submitted_by) : null;
        const submitter =
          submitterId ? await userRepo.findById(submitterId).catch(() => null) : null;

        for (const treatment of risk.treatments || []) {
          if (!treatment.due_date) continue;
          const due = startOfDay(treatment.due_date);
          if (due < today || due > end) continue;
          const daysUntil = Math.round((due - today) / 86400000);
          if (!daysBeforeList.includes(daysUntil)) continue;

          const label = daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
          const title = `Risk treatment due ${label}`;
          const msg = `Treatment "${treatment.control_action || 'Action'}" for risk "${risk.risk_title || risk.title || 'Risk'}" is due by ${formatDate(treatment.due_date)}.`;
          const link = '/risk-management';

          const recipientsForRisk = new Set(recipients);
          if (submitterId) recipientsForRisk.add(submitterId);

          for (const uid of recipientsForRisk) {
            const already = await notificationRepo.existsToday({
              user_id: uid,
              type: 'reminder_expiring',
              related_entity_id: risk._id,
              message_contains: 'Risk treatment'
            });
            if (already) continue;

            await notificationRepo.create({
              user_id: uid,
              type: 'reminder_expiring',
              title: 'Risk treatment due',
              message: msg,
              link,
              related_entity_id: risk._id,
              related_entity_type: 'risk',
              created_at: new Date()
            });
            reminderCount += 1;
            const u = await userRepo.findById(uid).catch(() => null);
            if (u?.email) {
              emailService
                .sendEmail({
                  to: u.email,
                  subject: title,
                  text: msg,
                  html: ''
                })
                .catch(() => {});
              logInfo('Reminder email sent (risk treatment)', {
                orgId,
                userId: String(uid),
                riskId: String(risk._id)
              });
            }
          }
        }
      }

      // ── Responsible people checks (WWCC / Police) ──────────────────────────
      const boardMemberSchema = (await import('../db/schemas/platform/boardMemberSchema.js')).default;
      tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
      const BoardMember = tenantDb.model('BoardMember');

      const members = await BoardMember.find({
        org_id: orgObjectId,
        is_active: true,
        status: 'active',
        $or: [
          { 'wwcc.expiry_date': { $exists: true, $ne: null, $gte: today, $lte: end } },
          { 'police_check.expiry_date': { $exists: true, $ne: null, $gte: today, $lte: end } }
        ]
      })
        .select('_id user_id full_name wwcc police_check')
        .lean();

      for (const m of members) {
        const checks = [
          { kind: 'Working With Children Check', data: m.wwcc },
          { kind: 'Police Check', data: m.police_check }
        ];
        for (const c of checks) {
          if (!c.data || !c.data.expiry_date) continue;
          const expiry = startOfDay(c.data.expiry_date);
          if (expiry < today || expiry > end) continue;
          const daysUntil = Math.round((expiry - today) / 86400000);
          if (!daysBeforeList.includes(daysUntil)) continue;

          const label = daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
          const title = `${c.kind} expires ${label}`;
          const msg = `${c.kind} for ${m.full_name || 'responsible person'} expires on ${formatDate(c.data.expiry_date)}.`;
          const link = '/governance/responsible-people';

          const userIds = [];
          if (m.user_id) userIds.push(String(m.user_id));
          userIds.push(...recipients);

          for (const uid of new Set(userIds)) {
            const already = await notificationRepo.existsToday({
              user_id: uid,
              type: 'reminder_expiring',
              related_entity_id: m._id,
              message_contains: c.kind
            });
            if (already) continue;

            await notificationRepo.create({
              user_id: uid,
              type: 'reminder_expiring',
              title: `${c.kind} expiring`,
              message: msg,
              link,
              related_entity_id: m._id,
              related_entity_type: 'board_member',
              created_at: new Date()
            });
            reminderCount += 1;
            const u = await userRepo.findById(uid).catch(() => null);
            if (u?.email) {
              emailService
                .sendEmail({
                  to: u.email,
                  subject: title,
                  text: msg,
                  html: ''
                })
                .catch(() => {});
              logInfo('Reminder email sent (responsible person check)', {
                orgId,
                userId: String(uid),
                boardMemberId: String(m._id),
                checkKind: c.kind
              });
            }
          }
        }
      }

      // ── Privacy policy review reminders (7d, 3d, overdue escalation) ─────────
      const policySchema = (await import('../db/schemas/platform/policySchema.js')).default;
      tenantDb.models.Policy || tenantDb.model('Policy', policySchema);
      const Policy = tenantDb.model('Policy');

      const policyEnd = new Date(today);
      policyEnd.setDate(policyEnd.getDate() + Math.max(maxDays, 7));
      const policyOverdueStart = new Date(today);
      policyOverdueStart.setDate(policyOverdueStart.getDate() - (ESCALATION_HOD_DAYS_OVERDUE + ESCALATION_BOARD_DAYS_AFTER_HOD + 1));

      const privacyPolicies = await Policy.find({
        org_id: orgObjectId,
        category: { $in: ['privacy_policy', 'privacy'] },
        status: { $in: ['active', 'under_review'] },
        next_review_date: { $exists: true, $ne: null, $lte: policyEnd, $gte: policyOverdueStart }
      })
        .select('_id title category next_review_date department_id policy_owner_id status reviewed_at')
        .lean();

      for (const p of privacyPolicies) {
        const due = startOfDay(p.next_review_date);
        const daysUntil = Math.round((due - today) / 86400000);
        const daysOverdue = daysUntil < 0 ? -daysUntil : 0;
        const link = '/policies';
        const title = p.title || 'Privacy policy';

        // Responsible person: policy owner (board member user) if available, else org recipients.
        let responsibleUid = null;
        if (p.policy_owner_id) {
          const bmSchema = (await import('../db/schemas/platform/boardMemberSchema.js')).default;
          tenantDb.models.BoardMember || tenantDb.model('BoardMember', bmSchema);
          const bm = await tenantDb.model('BoardMember').findById(p.policy_owner_id).select('user_id').lean();
          responsibleUid = bm?.user_id ? String(bm.user_id) : null;
        }
        const responsibleTargets = responsibleUid ? [responsibleUid] : recipients;

        if ([7, 3].includes(daysUntil)) {
          const label = `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
          const msg = `${toTitleCase(p.category)} should be reviewed by ${formatDate(p.next_review_date)}.`;
          for (const uid of responsibleTargets) {
            const already = await notificationRepo.existsToday({
              user_id: uid,
              type: 'policy_review_due',
              related_entity_id: p._id,
              message_contains: '[stage:responsible]'
            });
            if (already) continue;
            await notificationRepo.create({
              user_id: uid,
              type: 'policy_review_due',
              title: `${title} review due ${label}`,
              message: `${msg} [stage:responsible]`,
              link,
              related_entity_id: p._id,
              related_entity_type: 'policy',
              created_at: new Date()
            });
            reminderCount += 1;
          }
        }

        // Overdue escalation logic (only if not reviewed yet)
        const isActionTaken = !!p.reviewed_at || p.status === 'under_review';
        if (isActionTaken) continue;

        if (daysOverdue === ESCALATION_HOD_DAYS_OVERDUE) {
          const hodUid = await resolveHodUserIdForDepartment(tenantDb, orgObjectId, p.department_id).catch(() => null);
          if (hodUid) {
            const msg = `${title} review is overdue (due ${formatDate(p.next_review_date)}). No action has been recorded.`;
            const already = await notificationRepo.existsToday({
              user_id: hodUid,
              type: 'compliance_overdue_hod',
              related_entity_id: p._id,
              message_contains: '[stage:hod]'
            });
            if (!already) {
              await notificationRepo.create({
                user_id: hodUid,
                type: 'compliance_overdue_hod',
                title: `Overdue: ${title}`,
                message: `${msg} [stage:hod]`,
                link,
                related_entity_id: p._id,
                related_entity_type: 'policy',
                created_at: new Date()
              });
              reminderCount += 1;
            }
          }
        }

        if (daysOverdue === (ESCALATION_HOD_DAYS_OVERDUE + ESCALATION_BOARD_DAYS_AFTER_HOD)) {
          const msg = `${title} review is still overdue (due ${formatDate(p.next_review_date)}), and remains unaddressed after escalation.`;
          for (const boardUid of boardUserIds) {
            const already = await notificationRepo.existsToday({
              user_id: boardUid,
              type: 'compliance_overdue_board',
              related_entity_id: p._id,
              message_contains: '[stage:board]'
            });
            if (already) continue;
            await notificationRepo.create({
              user_id: boardUid,
              type: 'compliance_overdue_board',
              title: `Board escalation: ${title}`,
              message: `${msg} [stage:board]`,
              link,
              related_entity_id: p._id,
              related_entity_type: 'policy',
              created_at: new Date()
            });
            reminderCount += 1;
          }
        }
      }
    } catch (err) {
      console.error('Registration/license reminder run failed for tenant', orgId, err);
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

