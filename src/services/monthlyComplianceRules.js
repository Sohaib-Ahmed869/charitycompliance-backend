/**
 * Monthly Compliance auto-tick rules.
 *
 * Each rule knows how to decide, for a given calendar month, whether a
 * compliance item is satisfied by data already captured elsewhere in the
 * platform (board members, expenses, meetings, risks, etc.). Rules are
 * read-only: they run native count queries against the tenant DB and return
 * `{ satisfied, detail }`. They never mutate anything.
 *
 * The same registry powers two things:
 *   1. Catalogue items marked `type: 'auto'` (autoRuleKey) — evaluated each
 *      time the monthly register is read.
 *   2. User-added "criteria" items — a user picks one of these keys when
 *      adding a manual item that should auto-resolve at month end.
 *
 * Because each tenant has its own database, queries are NOT filtered by
 * org_id — the connection is already scoped to one organisation.
 */

/** UTC start/end of a calendar month (month is 1-12). */
export function monthWindow(year, month) {
  const y = Number(year);
  const m = Number(month); // 1-12
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)); // day 0 of next month = last day
  return { start, end };
}

// Helper: count documents in a collection, swallowing "collection missing"
// style errors so a tenant that has never used a module doesn't blow up the
// whole register (treated as zero matches).
async function safeCount(tenantDb, collectionName, query) {
  try {
    return await tenantDb.collection(collectionName).countDocuments(query);
  } catch {
    return 0;
  }
}

const pct = (done, total) => (total > 0 ? Math.round((done / total) * 100) : 0);

/**
 * Rule registry. Key → definition.
 *   label / description — shown in the criteria picker.
 *   group              — the module the rule naturally belongs to (UI only).
 *   evaluate({ tenantDb, win }) → { satisfied:boolean, detail:string }
 */
export const MONTHLY_COMPLIANCE_RULES = {
  'MONTHLY.BOARD_MEETING_HELD': {
    label: 'A board meeting was held this month',
    description: 'At least one completed meeting dated within the month.',
    group: 'Governance',
    async evaluate({ tenantDb, win }) {
      const held = await safeCount(tenantDb, 'meetings', { status: 'completed', date: { $gte: win.start, $lte: win.end } });
      return { satisfied: held > 0, detail: held > 0 ? `${held} completed meeting(s) this month.` : 'No completed meeting recorded this month.' };
    }
  },
  'MONTHLY.MEETING_MINUTES_CIRCULATED': {
    label: 'Meeting minutes / documents filed',
    description: 'A completed meeting this month has at least one document (minutes) attached.',
    group: 'Governance',
    async evaluate({ tenantDb, win }) {
      const withDocs = await safeCount(tenantDb, 'meetings', { status: 'completed', date: { $gte: win.start, $lte: win.end }, 'meeting_documents.0': { $exists: true } });
      return { satisfied: withDocs > 0, detail: withDocs > 0 ? `${withDocs} meeting(s) with documents filed.` : 'No meeting with minutes/documents filed this month.' };
    }
  },
  'MONTHLY.RESPONSIBLE_PERSONS_CURRENT': {
    label: 'Responsible persons / suitability up to date',
    description: 'Every active board member has a verified suitability check that has not lapsed by month end.',
    group: 'Governance',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'board_members', { is_active: true });
      if (total === 0) return { satisfied: false, detail: 'No active board members on record to verify.' };
      const outstanding = await safeCount(tenantDb, 'board_members', {
        is_active: true,
        $or: [
          { 'suitability_check.status': { $ne: 'verified' } },
          { 'suitability_check.next_review_date': { $lt: win.end } }
        ]
      });
      return { satisfied: outstanding === 0, detail: outstanding === 0 ? `All ${total} responsible person(s) verified and current.` : `${outstanding} of ${total} responsible person(s) not verified / overdue.` };
    }
  },
  'MONTHLY.COI_REVIEWED': {
    label: 'No conflict-of-interest declarations outstanding',
    description: 'There are no pending conflict-of-interest declarations awaiting action.',
    group: 'Governance',
    async evaluate({ tenantDb }) {
      const pending = await safeCount(tenantDb, 'coi_requests', { status: 'pending' });
      return { satisfied: pending === 0, detail: pending === 0 ? 'No pending conflict-of-interest declarations.' : `${pending} conflict-of-interest declaration(s) still pending.` };
    }
  },
  'MONTHLY.POLICIES_CURRENT': {
    label: 'Policies reviewed on schedule',
    description: 'There is at least one active policy and none are past their next review date by month end.',
    group: 'Governance',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'policies', { status: 'active' });
      if (total === 0) return { satisfied: false, detail: 'No active policies on record.' };
      const overdue = await safeCount(tenantDb, 'policies', { status: 'active', next_review_date: { $lt: win.end } });
      return { satisfied: overdue === 0, detail: overdue === 0 ? `All ${total} active policy(ies) within review schedule.` : `${overdue} of ${total} active policy(ies) overdue for review.` };
    }
  },
  'MONTHLY.COMPLAINTS_HANDLED': {
    label: 'Complaints raised this month are handled',
    description: 'No complaint raised this month is still open/unresolved.',
    group: 'Operations',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'complaints', { created_at: { $gte: win.start, $lte: win.end }, is_invalid: { $ne: true } });
      const open = await safeCount(tenantDb, 'complaints', { created_at: { $gte: win.start, $lte: win.end }, is_invalid: { $ne: true }, status: { $nin: ['resolved', 'invalid'] } });
      return { satisfied: open === 0, detail: open === 0 ? (total === 0 ? 'No complaints raised this month.' : `All ${total} complaint(s) this month handled.`) : `${open} complaint(s) raised this month still open.` };
    }
  },
  'MONTHLY.INCIDENTS_LOGGED': {
    label: 'Incidents this month are resolved/closed',
    description: 'No incident triggered this month is still open.',
    group: 'Risk and Compliance',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'bcp_emergency_activations', { triggered_at: { $gte: win.start, $lte: win.end } });
      const open = await safeCount(tenantDb, 'bcp_emergency_activations', { triggered_at: { $gte: win.start, $lte: win.end }, status: { $nin: ['resolved', 'closed'] } });
      return { satisfied: open === 0, detail: open === 0 ? (total === 0 ? 'No incidents triggered this month.' : `All ${total} incident(s) resolved/closed.`) : `${open} incident(s) this month still open.` };
    }
  },
  'MONTHLY.RISK_REVIEWED': {
    label: 'Risk register reviewed (none overdue)',
    description: 'There is at least one risk and none are past their next review date by month end.',
    group: 'Risk and Compliance',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'risks', { status: { $nin: ['closed', 'rejected'] } });
      if (total === 0) return { satisfied: false, detail: 'No active risks on the register.' };
      const overdue = await safeCount(tenantDb, 'risks', { status: { $nin: ['closed', 'rejected', 'resolved'] }, next_review_date: { $lt: win.end } });
      return { satisfied: overdue === 0, detail: overdue === 0 ? `All ${total} risk(s) within review schedule.` : `${overdue} risk(s) overdue for review.` };
    }
  },
  'MONTHLY.INSURANCE_ACTIVE': {
    label: 'Insurance cover active',
    description: 'At least one active insurance asset is recorded in the Systems Register.',
    group: 'Risk and Compliance',
    async evaluate({ tenantDb }) {
      const active = await safeCount(tenantDb, 'assets', {
        status: 'active',
        $or: [
          { category: { $regex: 'insurance', $options: 'i' } },
          { asset_name: { $regex: 'insurance', $options: 'i' } },
          { vendor_name: { $regex: 'insurance', $options: 'i' } }
        ]
      });
      return { satisfied: active > 0, detail: active > 0 ? `${active} active insurance asset(s) on record.` : 'No active insurance asset found in the Systems Register.' };
    }
  },
  'MONTHLY.TRAINING_CURRENT': {
    label: 'Mandatory training up to date',
    description: 'No training assignment is still outstanding (assigned / in progress).',
    group: 'People & HR',
    async evaluate({ tenantDb }) {
      const incomplete = await safeCount(tenantDb, 'training_enrollments', { status: { $in: ['assigned', 'not_started', 'in_progress'] } });
      return { satisfied: incomplete === 0, detail: incomplete === 0 ? 'No outstanding training assignments.' : `${incomplete} training assignment(s) still outstanding.` };
    }
  },
  'MONTHLY.WWCC_CURRENT': {
    label: 'WWCC / background checks current',
    description: 'Every active board member has a valid, unexpired WWCC or police check at month end.',
    group: 'People & HR',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'board_members', { is_active: true });
      if (total === 0) return { satisfied: false, detail: 'No active board members on record.' };
      const ok = await safeCount(tenantDb, 'board_members', {
        is_active: true,
        $or: [
          { 'wwcc.status': 'valid', 'wwcc.expiry_date': { $gt: win.end } },
          { 'police_check.status': 'valid', 'police_check.expiry_date': { $gt: win.end } }
        ]
      });
      return { satisfied: ok === total, detail: ok === total ? `All ${total} member(s) have a current WWCC/police check.` : `${total - ok} of ${total} member(s) missing a current WWCC/police check.` };
    }
  },
  'MONTHLY.EXPENSES_APPROVED': {
    label: 'All expenses this month approved',
    description: 'No expense raised this month is still draft / pending / awaiting resubmission.',
    group: 'Finance',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'expenses', { created_at: { $gte: win.start, $lte: win.end } });
      const outstanding = await safeCount(tenantDb, 'expenses', { created_at: { $gte: win.start, $lte: win.end }, status: { $in: ['draft', 'pending', 'resubmission_required'] } });
      return { satisfied: outstanding === 0, detail: outstanding === 0 ? (total === 0 ? 'No expenses raised this month.' : `All ${total} expense(s) this month approved/paid.`) : `${outstanding} of ${total} expense(s) this month still outstanding.` };
    }
  },
  'MONTHLY.DONATIONS_APPROVED': {
    label: 'Donations this month reconciled/approved',
    description: 'No donation recorded this month is still awaiting approval.',
    group: 'Finance',
    async evaluate({ tenantDb, win }) {
      const total = await safeCount(tenantDb, 'donations', { submitted_at: { $gte: win.start, $lte: win.end } });
      const outstanding = await safeCount(tenantDb, 'donations', { submitted_at: { $gte: win.start, $lte: win.end }, status: { $in: ['submitted', 'resubmission_required'] } });
      return { satisfied: outstanding === 0, detail: outstanding === 0 ? (total === 0 ? 'No donations recorded this month.' : `All ${total} donation(s) this month approved.`) : `${outstanding} of ${total} donation(s) this month awaiting approval.` };
    }
  },
  'MONTHLY.BAS_FISCAL_FILED': {
    label: 'BAS / fiscal report filed this month',
    description: 'An approved BAS lodgement or fiscal report was recorded this month.',
    group: 'Finance',
    async evaluate({ tenantDb, win }) {
      const filed = await safeCount(tenantDb, 'documents', { category: { $in: ['fiscal_report', 'bas_lodgement'] }, status: 'approved', created_at: { $gte: win.start, $lte: win.end } });
      return { satisfied: filed > 0, detail: filed > 0 ? `${filed} approved BAS/fiscal document(s) filed this month.` : 'No approved BAS/fiscal report filed this month.' };
    }
  }
};

/** Evaluate one rule key; returns null if the key is unknown. */
export async function evaluateMonthlyRule(ruleKey, ctx) {
  const rule = MONTHLY_COMPLIANCE_RULES[String(ruleKey || '').trim().toUpperCase()];
  if (!rule) return null;
  try {
    const res = await rule.evaluate(ctx);
    return { satisfied: !!res?.satisfied, detail: String(res?.detail || '') };
  } catch (err) {
    return { satisfied: false, detail: `Could not evaluate: ${err?.message || 'error'}` };
  }
}

/** Picker options for user-added criteria items. */
export function listMonthlyCriteriaOptions() {
  return Object.entries(MONTHLY_COMPLIANCE_RULES).map(([key, def]) => ({
    key,
    label: def.label,
    description: def.description,
    group: def.group || 'General'
  }));
}

export { pct as monthlyPct };
