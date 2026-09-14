/**
 * Migrate Expense/Purchase workflow checklists to I01 (Invoice Intake & Validation)
 *
 * Background: I01 (Invoice Intake & Validation) and I02 (Payment Approval &
 * Release) both live in Finance/Expenses and both target the `expense`/`purchase`
 * entity. The resolver scored them identically, so DB order decided which one
 * surfaced — and I02 sometimes appeared in I01's place when creating an expense.
 * The resolver now pins the expense target to I01 (via metadata.v3_checklist_id),
 * so NEW expenses resolve I01 and untouched stale instances self-heal on next
 * view. This script backfills the rest: it rebinds existing expense/purchase
 * checklist instances that are still on the wrong template over to I01.
 *
 * Safety: instances with any progress (a checked item, notes, evidence, or a
 * closed status) are LEFT ALONE — I02's item titles don't line up with I01's, so
 * swapping would silently discard completed compliance work. Those are reported
 * so they can be reviewed manually. Run is idempotent.
 *
 * Usage:
 *   node scripts/migrateExpenseChecklistToI01.js          # apply
 *   node scripts/migrateExpenseChecklistToI01.js --dry-run # report only
 */

import dotenv from 'dotenv';
import { connectRouterDB, closeRouterDB, getRouterConnection } from '../src/config/database.js';
import { getTenantConnection, closeAllConnections } from '../src/db/connectionManager.js';
import { logInfo, logError } from '../src/utils/logger.js';
import { ChecklistTemplateRepository } from '../src/repositories/checklistTemplateRepository.js';
import { ChecklistInstanceRepository } from '../src/repositories/checklistInstanceRepository.js';
import { ChecklistService } from '../src/services/checklistService.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

function instanceHasProgress(instance) {
  if (!instance) return false;
  if (instance.status === 'closed') return true;
  return (instance.items || []).some(
    (i) =>
      i?.checked ||
      i?.state === 'satisfied' ||
      (typeof i?.notes === 'string' && i.notes.trim().length > 0) ||
      (Array.isArray(i?.evidence) && i.evidence.length > 0)
  );
}

function buildItemsFromTemplate(template, existingInstance) {
  // Preserve any progress that maps by title (none will between I02 and I01,
  // but this keeps re-runs and same-checklist renames lossless).
  const byTitle = new Map(
    (existingInstance.items || []).map((i) => [
      String(i.title_snapshot || '').trim().toLowerCase(),
      i
    ])
  );
  return (template.items || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((ti) => {
      const prev = byTitle.get(String(ti.title || '').trim().toLowerCase());
      return {
        template_item_id: ti._id,
        title_snapshot: ti.title,
        description_snapshot: ti.description,
        category_snapshot: ti.category,
        type_snapshot: ti.type,
        auto_rule_key_snapshot: ti.autoRuleKey,
        required_evidence_snapshot: ti.requiredEvidence,
        state: prev?.state || 'pending',
        checked: !!prev?.checked,
        checked_by: prev?.checked_by || null,
        checked_at: prev?.checked_at || null,
        notes: prev?.notes || '',
        evidence: prev?.evidence || []
      };
    });
}

async function migrate() {
  logInfo(`Starting expense → I01 checklist migration${DRY_RUN ? ' (DRY RUN)' : ''}`);

  await connectRouterDB();
  const tenants = await getRouterConnection()
    .collection('tenants')
    .find({ status: 'active' })
    .toArray();
  logInfo(`Found ${tenants.length} active tenants`);

  const totals = { rebound: 0, skippedHasProgress: 0, alreadyI01: 0, orgsNoI01: 0 };

  for (const tenant of tenants) {
    const orgId = tenant.orgId;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const templateRepo = new ChecklistTemplateRepository(tenantDb);
      const instanceRepo = new ChecklistInstanceRepository(tenantDb);

      // In apply mode, ensure the V3 library (incl. I01) exists for this tenant
      // so legacy expense instances created before V3 — bound to the old
      // "Expense Workflow Compliance Checklist" — can also be migrated. This is
      // idempotent and exactly what the app does on first checklist resolve.
      // Dry-run stays read-only and just reports orgs that lack I01.
      if (!DRY_RUN) {
        await new ChecklistService(orgId).ensureV3Bootstrapped();
      }

      // Resolve this tenant's I01 template by its stable V3 id.
      const moduleTemplates = await templateRepo.list(orgId, { type: 'module' });
      const i01 = moduleTemplates.find(
        (t) => String(t?.metadata?.v3_checklist_id || '').trim().toLowerCase() === 'i01'
      );
      if (!i01) {
        totals.orgsNoI01++;
        logInfo(
          DRY_RUN
            ? `Org ${orgId}: no I01 template yet — apply run will bootstrap the V3 library, then migrate`
            : `Org ${orgId}: no I01 template even after bootstrap — skipping`
        );
        continue;
      }

      // Gather expense + purchase instances.
      const instances = [
        ...(await instanceRepo.list(orgId, { type: 'module', entityType: 'expense' })),
        ...(await instanceRepo.list(orgId, { type: 'module', entityType: 'purchase' }))
      ];

      let orgRebound = 0;
      let orgSkipped = 0;
      let orgAlready = 0;

      for (const inst of instances) {
        if (String(inst.template_id) === String(i01._id)) {
          orgAlready++;
          continue;
        }
        if (instanceHasProgress(inst)) {
          orgSkipped++;
          logInfo(
            `Org ${orgId}: KEEP instance ${inst._id} (entity ${inst?.context?.entityType}/${inst?.context?.entityId}) — has progress/closed, left on its current checklist`
          );
          continue;
        }

        if (DRY_RUN) {
          orgRebound++;
          logInfo(`Org ${orgId}: [dry-run] would rebind instance ${inst._id} → I01`);
          continue;
        }

        await instanceRepo.update(inst._id, {
          template_id: i01._id,
          items: buildItemsFromTemplate(i01, inst)
        });
        orgRebound++;
      }

      totals.rebound += orgRebound;
      totals.skippedHasProgress += orgSkipped;
      totals.alreadyI01 += orgAlready;

      if (orgRebound || orgSkipped) {
        logInfo(
          `Org ${orgId}: rebound ${orgRebound}, skipped(has progress) ${orgSkipped}, already I01 ${orgAlready}`
        );
      }
    } catch (error) {
      logError(`Error processing org ${orgId}:`, error);
    }
  }

  logInfo(
    `Migration ${DRY_RUN ? '(dry run) ' : ''}complete. Rebound: ${totals.rebound}, ` +
      `skipped (had progress): ${totals.skippedHasProgress}, already I01: ${totals.alreadyI01}, ` +
      `orgs without I01: ${totals.orgsNoI01}`
  );

  await closeAllConnections().catch(() => {});
  await closeRouterDB().catch(() => {});
  process.exit(0);
}

migrate().catch(async (error) => {
  logError('Migration failed:', error);
  await closeAllConnections().catch(() => {});
  await closeRouterDB().catch(() => {});
  process.exit(1);
});
