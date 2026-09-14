/**
 * Reminder Config helper (Router DB, GLOBAL)
 *
 * Thin accessor over the ReminderConfig router model. The config is global
 * (super-admin owned) — there is exactly one document per reminder_type. For
 * now the only type is 'approval'.
 */

import getRouterModels from '../db/models/routerModels.js';

export const APPROVAL_REMINDER_TYPE = 'approval';

const DEFAULT_APPROVAL_CONFIG = {
  reminder_type: APPROVAL_REMINDER_TYPE,
  enabled: true,
  offsets_hours: [24, 48, 72],
  max_reminders: 5
};

/**
 * Return the global approval reminder config, creating the default document if
 * it doesn't exist yet.
 */
export async function getApprovalReminderConfig() {
  const { ReminderConfig } = getRouterModels();
  let doc = await ReminderConfig.findOne({ reminder_type: APPROVAL_REMINDER_TYPE });
  if (!doc) {
    doc = await ReminderConfig.create({ ...DEFAULT_APPROVAL_CONFIG });
  }
  return doc;
}

/**
 * Sanitize + persist an update to the approval config.
 * @param {object} patch  { enabled?, offsets_hours?, max_reminders? }
 * @param {string|null} updatedBy  super-admin user id
 */
export async function updateApprovalReminderConfig(patch = {}, updatedBy = null) {
  const { ReminderConfig } = getRouterModels();
  const doc = await getApprovalReminderConfig();

  if (patch.enabled !== undefined) doc.enabled = !!patch.enabled;

  if (patch.offsets_hours !== undefined) {
    // Dedupe positive numbers and sort ascending.
    const cleaned = Array.from(
      new Set(
        (patch.offsets_hours || [])
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
      )
    ).sort((a, b) => a - b);
    doc.offsets_hours = cleaned;
  }

  if (patch.max_reminders !== undefined) {
    const n = Number(patch.max_reminders);
    if (Number.isFinite(n) && n >= 0) doc.max_reminders = Math.trunc(n);
  }

  doc.updated_by = updatedBy || doc.updated_by || null;
  await doc.save();
  return doc;
}

export default { getApprovalReminderConfig, updateApprovalReminderConfig, APPROVAL_REMINDER_TYPE };
