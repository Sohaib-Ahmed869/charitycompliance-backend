/**
 * Attach approval workflow records to the previously-seeded risks and COIs
 * so they show up in approval/workflow views and the dashboard.
 *
 * Usage:
 *   node scripts/seedWorkflowsForSeededData.js <orgId>
 *
 * For each seeded risk (title contains "— sample"):
 *   - Find a matching ApprovalMatrix (workflow_category 'risk_management')
 *   - Create an ApprovalRequest with entity_type='risk', steps copied
 *     from matrix.rules[0].requires_approval_from
 *   - Stamp step decisions to mirror the risk's status
 *   - Link risk.approval_request_id back to the new ApprovalRequest
 *
 * For each seeded COI (conflict_person_name like "Sample Person N"):
 *   - Find the ApprovalMatrix with workflow_category 'coi'
 *   - Populate the COI's embedded approval_steps from that matrix
 *   - Mirror the COI's status in the steps
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import { getTenantConnection, closeAllConnections } from '../src/db/connectionManager.js';
import riskSchema from '../src/db/schemas/platform/riskSchema.js';
import coiRequestSchema from '../src/db/schemas/platform/coiRequestSchema.js';
import approvalRequestSchema from '../src/db/schemas/platform/approvalRequestSchema.js';
import approvalMatrixSchema from '../src/db/schemas/platform/approvalMatrixSchema.js';
import organizationSchema from '../src/db/schemas/platform/organizationSchema.js';
import positionSchema from '../src/db/schemas/platform/positionSchema.js';
import boardMemberSchema from '../src/db/schemas/platform/boardMemberSchema.js';

dotenv.config();

const orgId = (process.argv[2] || '').trim();
if (!orgId) {
  console.error('Usage: node scripts/seedWorkflowsForSeededData.js <orgId>');
  process.exit(1);
}

const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

// Map an entity status onto the per-step decisions we'll stamp.
// `positionToUser` resolves position_id → current holder user_id.
function stampSteps(rawSteps, entityStatus, positionToUser = new Map()) {
  return rawSteps.map((step, idx) => {
    const positionId = step.position_id || step.approver_position_id || null;
    // Prefer an explicit user on the rule. Fall back to whoever currently
    // holds the position so the step renders as "<Person> (Secretary)"
    // rather than "Unassigned".
    const resolvedUser = step.user_id
      || step.approver_user_id
      || (positionId ? positionToUser.get(String(positionId)) : null)
      || null;

    const base = {
      level: step.approval_level || idx + 1,
      approver_user_id: resolvedUser,
      approver_position_id: positionId,
      approver_department_id: step.department_id || step.approver_department_id || null,
      status: 'pending',
      approved_at: null,
      rejected_at: null,
    };

    if (entityStatus === 'approved' || entityStatus === 'resolved' || entityStatus === 'closed' || entityStatus === 'under_treatment') {
      base.status = 'approved';
      base.approved_at = dayOffset(-Math.floor(Math.random() * 30));
    } else if (entityStatus === 'rejected') {
      // Approve early steps, reject the last
      if (idx < rawSteps.length - 1) {
        base.status = 'approved';
        base.approved_at = dayOffset(-Math.floor(Math.random() * 30));
      } else {
        base.status = 'rejected';
        base.rejected_at = dayOffset(-Math.floor(Math.random() * 20));
        base.rejection_reason = 'Rejected as part of seeded sample data';
      }
    } else {
      // pending / draft / cancelled: leave pending
      base.status = 'pending';
    }
    return base;
  });
}

function entityStatusToRequestStatus(entityStatus) {
  if (entityStatus === 'approved' || entityStatus === 'resolved' || entityStatus === 'closed' || entityStatus === 'under_treatment') return 'approved';
  if (entityStatus === 'rejected') return 'rejected';
  return 'pending';
}

async function main() {
  console.log('📡 Connecting to Router DB…');
  await connectRouterDB();

  console.log(`🔍 Tenant: ${orgId}`);
  const tenantDb = await getTenantConnection(orgId);

  // Register related models so populate / discriminators are happy
  tenantDb.models.Position || tenantDb.model('Position', positionSchema);
  tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);

  const Organization = tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
  const ApprovalMatrix = tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
  const ApprovalRequest = tenantDb.models.ApprovalRequest || tenantDb.model('ApprovalRequest', approvalRequestSchema);
  const Risk = tenantDb.models.Risk || tenantDb.model('Risk', riskSchema);
  const CoiRequest = tenantDb.models.CoiRequest || tenantDb.model('CoiRequest', coiRequestSchema);
  const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);

  const org = await Organization.findOne();
  const orgObjectId = org?._id;
  if (!orgObjectId) {
    console.error('❌ No Organization document found in tenant DB.');
    process.exit(1);
  }

  // Build a position_id → user_id map from active board members so we can
  // resolve a workflow's "approver position" to the actual holder.
  const activeBoardMembers = await BoardMember.find({
    org_id: orgObjectId,
    is_active: true,
    status: 'active',
    user_id: { $exists: true, $ne: null },
    position_id: { $exists: true, $ne: null },
  }).select('user_id position_id').lean();

  const positionToUser = new Map();
  for (const bm of activeBoardMembers) {
    positionToUser.set(String(bm.position_id), bm.user_id);
  }
  console.log(`   Loaded ${positionToUser.size} position → user mapping${positionToUser.size === 1 ? '' : 's'}`);

  // Find any user to use as submitted_by (required on ApprovalRequest).
  const sourceRisk = await Risk.findOne({ submitted_by: { $exists: true, $ne: null } }).select('submitted_by').lean();
  const fallbackSubmitter = sourceRisk?.submitted_by || null;
  if (!fallbackSubmitter) {
    console.warn('⚠️  Could not find a submitted_by user from existing risks. Will use a placeholder.');
  }

  // ── RISKS ─────────────────────────────────────────────────────────────
  const matrices = await ApprovalMatrix.find({
    org_id: orgObjectId,
    is_active: true,
    revoked_at: null,
  }).lean();

  // Pick one risk-management matrix per priority. Many configurations have
  // multiple (high/medium/low). We'll just round-robin if we find them.
  const riskMatrices = matrices.filter((m) => m.workflow_category === 'risk_management' && (m.rules || []).some((r) => r.action_type === 'risk' || r.action_type === 'risk_management'));

  console.log(`\n🛡️  Risk matrices available: ${riskMatrices.length}`);

  const seededRisks = await Risk.find({ org_id: orgObjectId, title: { $regex: /— sample/ } });
  console.log(`   Found ${seededRisks.length} seeded risks to process.`);

  let createdRiskRequests = 0, updatedRisks = 0;
  for (let i = 0; i < seededRisks.length; i++) {
    const risk = seededRisks[i];

    // If the risk has an approval_request_id, only respect it if the
    // ApprovalRequest's entity_id actually points back at this risk —
    // otherwise it's a stale reference inherited from a copied source.
    // Also re-create if any step is unassigned but has a position (we now
    // resolve the position holder so steps render with the real user).
    if (risk.approval_request_id) {
      const existing = await ApprovalRequest.findById(risk.approval_request_id).lean();
      if (existing && String(existing.entity_id) === String(risk._id)) {
        const hasUnresolved = (existing.approval_steps || []).some(
          (s) => !s.approver_user_id && s.approver_position_id
        );
        if (!hasUnresolved) {
          console.log(`   • skip "${risk.title}" — already linked to ${existing._id}`);
          continue;
        }
        console.log(`   ⤳ "${risk.title}" — existing request has unresolved approvers, re-creating`);
        await ApprovalRequest.deleteOne({ _id: existing._id });
      } else if (existing) {
        console.log(`   ⤳ stale link on "${risk.title}" (request points to a different risk) — re-creating`);
      }
    }

    const matrix = riskMatrices[i % Math.max(1, riskMatrices.length)];
    if (!matrix) {
      console.log(`   • skip "${risk.title}" — no risk_management matrix configured`);
      continue;
    }

    // Pick the rule that matches the action_type 'risk' or first rule.
    const rule = (matrix.rules || []).find((r) => r.action_type === 'risk') || (matrix.rules || [])[0];
    if (!rule) {
      console.log(`   • skip "${risk.title}" — matrix has no rules`);
      continue;
    }

    const rawSteps = rule.requires_approval_from || [];
    if (!rawSteps.length) {
      console.log(`   • skip "${risk.title}" — rule has no approvers`);
      continue;
    }

    const stamped = stampSteps(rawSteps, risk.status, positionToUser);
    const requestStatus = entityStatusToRequestStatus(risk.status);
    const completedAt = ['approved', 'rejected'].includes(requestStatus) ? dayOffset(-Math.floor(Math.random() * 20)) : null;

    const request = await ApprovalRequest.create({
      org_id: orgObjectId,
      request_type: 'risk',
      entity_id: risk._id,
      entity_type: 'risk',
      amount: 0,
      approval_matrix_id: matrix._id,
      approval_type: rule.approval_type || matrix.default_approval_type || 'sequential',
      status: requestStatus,
      approval_steps: stamped,
      submitted_by: risk.submitted_by || fallbackSubmitter || new mongoose.Types.ObjectId(),
      created_at: risk.created_at || dayOffset(-30),
      completed_at: completedAt,
    });

    risk.approval_request_id = request._id;
    risk.approval_matrix_id = matrix._id;
    await risk.save();

    createdRiskRequests++;
    updatedRisks++;
    console.log(`   ✓ "${risk.title}" → ApprovalRequest ${request._id}  [${requestStatus}, ${stamped.length} step${stamped.length === 1 ? '' : 's'}]`);
  }
  console.log(`   → ${createdRiskRequests} approval requests created, ${updatedRisks} risks linked`);

  // ── COIs ──────────────────────────────────────────────────────────────
  const coiMatrix = matrices.find((m) => m.workflow_category === 'coi');
  console.log(`\n⚖️  COI matrix available: ${coiMatrix ? 'yes' : 'no'}`);

  const seededCois = await CoiRequest.find({ org_id: orgObjectId, conflict_person_name: { $regex: /^Sample Person/ } });
  console.log(`   Found ${seededCois.length} seeded COIs to process.`);

  let updatedCois = 0;
  if (coiMatrix) {
    const coiRule = (coiMatrix.rules || []).find((r) => r.action_type === 'coi') || (coiMatrix.rules || [])[0];
    const rawCoiSteps = coiRule?.requires_approval_from || [];

    if (!rawCoiSteps.length) {
      console.log('   • COI matrix has no approvers configured — skipping.');
    } else {
      for (const coi of seededCois) {
        const existing = coi.approval_steps || [];
        // Re-stamp if any step is missing approver_user_id but has a position
        // (i.e. the previous run couldn't resolve who currently holds the role).
        const needsRestamp = existing.length > 0 &&
          existing.some((s) => !s.approver_user_id && s.approver_position_id);
        if (existing.length > 0 && !needsRestamp) {
          console.log(`   • skip "${coi.conflict_person_name}" — already has resolved steps`);
          continue;
        }
        if (needsRestamp) {
          console.log(`   ⤳ re-stamp "${coi.conflict_person_name}" (steps had unresolved approvers)`);
        }

        const stamped = stampSteps(rawCoiSteps, coi.status, positionToUser);
        coi.approval_steps = stamped;
        coi.approval_matrix_id = coiMatrix._id;
        coi.approval_type = coiRule.approval_type || 'sequential';
        await coi.save();

        updatedCois++;
        console.log(`   ✓ "${coi.conflict_person_name}" → ${stamped.length} step${stamped.length === 1 ? '' : 's'} [${coi.status}]`);
      }
    }
  } else {
    console.log('   • Configure a COI workflow first (workflow_category = "coi"), then re-run.');
  }
  console.log(`   → ${updatedCois} COI${updatedCois === 1 ? '' : 's'} updated`);

  await closeAllConnections();
  await closeRouterDB();
  console.log('\n✅ Done.');
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
