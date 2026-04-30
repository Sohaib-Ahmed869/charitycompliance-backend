/**
 * Duplicate existing risks + meetings with small tweaks so dashboards have
 * meaningful sample data. Idempotent-ish: skips inserts if a "(copy N)" of
 * the same source already exists.
 *
 * Usage:
 *   node scripts/seedMoreDataForOrg.js <orgId> [--risks=N] [--meetings=N]
 *
 * Default: 6 risk copies, 6 meeting copies.
 */

import dotenv from 'dotenv';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import { getTenantConnection, closeAllConnections } from '../src/db/connectionManager.js';
import riskSchema from '../src/db/schemas/platform/riskSchema.js';
import meetingSchema from '../src/db/schemas/platform/meetingSchema.js';
import coiRequestSchema from '../src/db/schemas/platform/coiRequestSchema.js';

dotenv.config();

const orgId = (process.argv[2] || '').trim();
const riskCount = Number((process.argv.find((a) => a.startsWith('--risks=')) || '--risks=6').split('=')[1]) || 6;
const meetingCount = Number((process.argv.find((a) => a.startsWith('--meetings=')) || '--meetings=6').split('=')[1]) || 6;
const coiCount = Number((process.argv.find((a) => a.startsWith('--cois=')) || '--cois=10').split('=')[1]) || 10;

if (!orgId) {
  console.error('Usage: node scripts/seedMoreDataForOrg.js <orgId> [--risks=N] [--meetings=N] [--cois=N]');
  process.exit(1);
}

const RISK_TITLE_VARIATIONS = [
  'Cyber security breach',
  'Volunteer safeguarding lapse',
  'Funder withdrawal',
  'Cash handling discrepancy',
  'Unapproved expenditure',
  'Data privacy breach',
  'Workplace injury',
  'Reputation damage from media',
  'Donor concentration risk',
  'Conflict of interest unmanaged',
  'Insurance lapse',
  'Compliance reporting overdue',
];

const RISK_STATUSES = ['draft', 'pending', 'under_treatment', 'approved', 'resolved', 'closed'];
const SEVERITY_LEVELS = ['low', 'moderate', 'high', 'extreme', 'critical'];
const TRENDS = ['improving', 'stable', 'worsening', 'unknown'];

const MEETING_TITLES = [
  'Board strategy review',
  'Quarterly governance check-in',
  'Risk committee meeting',
  'Audit committee briefing',
  'Annual compliance review',
  'Programs update',
  'Finance subcommittee',
  'Funder reporting workshop',
];

const ATTENDEE_STATUSES = ['attended', 'confirmed', 'declined', 'invited'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

async function main() {
  console.log(`📡 Connecting to Router DB…`);
  await connectRouterDB();

  console.log(`🔍 Looking up tenant: ${orgId}`);
  const tenantDb = await getTenantConnection(orgId);

  const Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);
  const Meeting = tenantDb.models.Meeting || tenantDb.model('Meeting', meetingSchema);
  const CoiRequest = tenantDb.models.CoiRequest || tenantDb.model('CoiRequest', coiRequestSchema);

  // ── RISKS ─────────────────────────────────────────────────────────────
  const sourceRisks = await Risk.find({ org_id: { $exists: true } }).limit(20).lean();
  if (!sourceRisks.length) {
    console.log('⚠️  No source risks found to duplicate from. Skipping risks.');
  } else {
    const orgIdValue = sourceRisks[0].org_id;
    console.log(`\n🛡️  Seeding risks (using ${sourceRisks.length} source records)…`);

    let inserted = 0;
    for (let i = 0; i < riskCount; i++) {
      const src = sourceRisks[i % sourceRisks.length];
      const titleSuffix = RISK_TITLE_VARIATIONS[i % RISK_TITLE_VARIATIONS.length];
      const newTitle = `${titleSuffix} — sample ${i + 1}`;

      const exists = await Risk.findOne({ org_id: orgIdValue, title: newTitle }).lean();
      if (exists) {
        console.log(`   • skip "${newTitle}" (already exists)`);
        continue;
      }

      // Build a fresh document by copying source fields, omitting _id, and
      // tweaking severity / status / dates / trend so the dashboard mix is varied.
      const { _id, createdAt, updatedAt, __v, ...rest } = src;
      const inherent = pick(SEVERITY_LEVELS);
      const residual = pick(SEVERITY_LEVELS);
      const status = pick(RISK_STATUSES);

      const doc = {
        ...rest,
        title: newTitle,
        description: rest.description ? `${rest.description} (sample copy ${i + 1})` : `Sample seeded risk ${i + 1} for dashboard testing.`,
        inherent_risk_level: inherent,
        residual_risk_level: residual,
        status,
        trend: pick(TRENDS),
        next_review_date: dayOffset(Math.floor(Math.random() * 60) - 20), // some overdue, some upcoming
        created_at: dayOffset(-Math.floor(Math.random() * 120)),
        updated_at: new Date(),
      };

      await Risk.create(doc);
      inserted++;
      console.log(`   ✓ "${newTitle}"  [${inherent}/${residual} · ${status}]`);
    }
    console.log(`   → inserted ${inserted} risk${inserted === 1 ? '' : 's'}`);
  }

  // ── MEETINGS ──────────────────────────────────────────────────────────
  const sourceMeetings = await Meeting.find({ org_id: { $exists: true } }).limit(10).lean();
  if (!sourceMeetings.length) {
    console.log('\n⚠️  No source meetings found to duplicate from. Skipping meetings.');
  } else {
    console.log(`\n📅 Seeding meetings (using ${sourceMeetings.length} source records)…`);

    let inserted = 0;
    for (let i = 0; i < meetingCount; i++) {
      const src = sourceMeetings[i % sourceMeetings.length];
      const newTitle = `${MEETING_TITLES[i % MEETING_TITLES.length]} — sample ${i + 1}`;

      const exists = await Meeting.findOne({ org_id: src.org_id, title: newTitle }).lean();
      if (exists) {
        console.log(`   • skip "${newTitle}" (already exists)`);
        continue;
      }

      // Mix dates: half upcoming (scheduled), half historical (completed)
      const isUpcoming = i % 2 === 0;
      const offsetDays = isUpcoming
        ? 3 + i * 4 // 3, 7, 11, 15… days out
        : -(7 + i * 5); // 7, 12, 17… days back

      const status = isUpcoming ? 'scheduled' : 'completed';

      const attendees = (src.attendees || []).slice(0, 6).map((a, idx) => ({
        user_id: a.user_id,
        rsvp_token: undefined, // unique tokens not needed for sample
        rsvp_at: status === 'completed' ? new Date() : null,
        attendance_status: status === 'completed'
          ? (idx < 4 ? 'attended' : pick(ATTENDEE_STATUSES))
          : (idx === 0 ? 'invited' : pick(['confirmed', 'invited', 'declined']))
      }));

      const { _id, createdAt, updatedAt, __v, reminder_sent, ...rest } = src;
      const doc = {
        ...rest,
        title: newTitle,
        date: dayOffset(offsetDays),
        agenda: rest.agenda || `${newTitle} — agenda placeholder for dashboard sample.`,
        status,
        completed_at: status === 'completed' ? dayOffset(offsetDays + 1) : undefined,
        attendees,
        external_attendees: [],
        meeting_documents: [],
        internal_notes: [],
        is_important: i % 3 === 0,
        is_exported_for_audit: false,
        reminder_sent: { one_hour_for_date: null, fifteen_min_for_date: null },
        created_at: dayOffset(offsetDays - 14),
        updated_at: new Date(),
      };

      await Meeting.create(doc);
      inserted++;
      console.log(`   ✓ "${newTitle}"  [${status} · ${doc.date.toDateString()}]`);
    }
    console.log(`   → inserted ${inserted} meeting${inserted === 1 ? '' : 's'}`);
  }

  // ── COIs ──────────────────────────────────────────────────────────────
  // Find any existing COI to use as a template (org_id, etc.). If none, fall
  // back to the orgIdValue used by risks and synthesise minimal COIs.
  const existingCoi = await CoiRequest.findOne().lean();
  const orgValueForCoi = existingCoi?.org_id || (sourceRisks[0]?.org_id) || null;
  const sourceUserId = existingCoi?.submitted_by || sourceRisks[0]?.created_by || null;

  if (!orgValueForCoi) {
    console.log('\n⚠️  Could not determine org_id for COIs. Skipping COIs.');
  } else {
    console.log(`\n⚖️  Seeding COIs (template: ${existingCoi ? 'existing record' : 'minimal synthesised'})…`);
    const COI_REASONS = [
      'Personal relationship with vendor under consideration',
      'Family member is a beneficiary of grant program',
      'Director sits on board of recipient charity',
      'Spouse employed by service provider',
      'Personal financial interest in funding agreement',
      'Past employment with potential partner',
      'Owns shares in supplier company',
      'Friend of donor with significant gift',
      'Holds advisory role with competing applicant',
      'Disclosed gift from grant recipient',
    ];
    const STATUSES = ['pending', 'pending', 'approved', 'approved', 'approved', 'rejected'];
    const APPROVAL_TYPES = ['sequential', 'parallel', 'any'];

    let inserted = 0;
    for (let i = 0; i < coiCount; i++) {
      const reason = COI_REASONS[i % COI_REASONS.length];
      const personName = `Sample Person ${i + 1}`;
      const exists = await CoiRequest.findOne({ org_id: orgValueForCoi, conflict_person_name: personName }).lean();
      if (exists) {
        console.log(`   • skip "${personName}" (already exists)`);
        continue;
      }

      const isExternal = i % 4 === 0;
      const status = STATUSES[i % STATUSES.length];
      const approvalType = APPROVAL_TYPES[i % APPROVAL_TYPES.length];
      const createdAt = dayOffset(-Math.floor(Math.random() * 180));
      const completedAt = status !== 'pending' ? dayOffset(-Math.floor(Math.random() * 30)) : null;

      const doc = {
        org_id: orgValueForCoi,
        coi_reason: reason,
        conflict_person_name: personName,
        conflict_person_details: `Sample COI declaration ${i + 1} for dashboard testing.`,
        submission_source: isExternal ? 'external' : 'internal',
        is_external: isExternal,
        ...(isExternal ? {
          external_submitter: {
            name: `External Submitter ${i + 1}`,
            email: `external${i + 1}@example.com`,
          }
        } : {}),
        approval_type: approvalType,
        status,
        approval_steps: [],
        submitted_by: sourceUserId,
        created_at: createdAt,
        completed_at: completedAt,
      };

      await CoiRequest.create(doc);
      inserted++;
      console.log(`   ✓ "${personName}"  [${status} · ${isExternal ? 'external' : 'internal'}]`);
    }
    console.log(`   → inserted ${inserted} COI${inserted === 1 ? '' : 's'}`);
  }

  await closeAllConnections();
  await closeRouterDB();
  console.log('\n✅ Done.');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
