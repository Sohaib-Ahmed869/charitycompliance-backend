/**
 * Seed the Calcite admin catalogue: the 3 canonical plans (Foundation,
 * Professional, Enterprise) and the FeatureFlag catalogue from handbook §4.
 *
 * Idempotent — safe to re-run. Plans are upserted by plan_code; flags by
 * code. Feature flag membership on each plan reflects the handbook's tier
 * matrix exactly.
 *
 * Usage:  node scripts/seedAdminCatalogue.js
 */

import { connectRouterDB } from '../src/config/database.js';
import getRouterModels from '../src/db/models/routerModels.js';
import { logInfo, logError } from '../src/utils/logger.js';

// ── Feature flag catalogue (handbook §4) ───────────────────────────────
const FLAGS = [
  // Governance — included on every tier
  ['governance.organisation',          'governance', 'Organisation & Responsible Persons register', ['F','P','E']],
  ['governance.board_portal',          'governance', 'Agendas, packs, minutes, decision register', ['F','P','E']],
  ['governance.policy_management',     'governance', 'Policy lifecycle, acknowledge, version', ['F','P','E']],
  ['governance.risk_register',         'governance', 'Risk register & matrix', ['F','P','E']],
  ['governance.complaints',            'governance', 'Complaints register', ['F','P','E']],
  ['governance.incidents',             'governance', 'Incidents register', ['F','P','E']],
  ['governance.compliance_checklist',  'governance', 'ACNC GS 1–6 checklists', ['F','P','E']],
  ['governance.ais_workflow',          'governance', 'Annual Information Statement workflow', ['F','P','E']],
  // Security — every tier
  ['security.audit_log',               'security',   'Immutable audit log', ['F','P','E']],
  ['security.mfa',                     'security',   'Multi-factor authentication', ['F','P','E']],
  ['security.rbac',                    'security',   'Role-based permissions', ['F','P','E']],
  // Finance — Professional + Enterprise
  ['finance.expense_workflow',         'finance',    'Expense workflow with dual approval', ['P','E']],
  ['finance.invoice_workflow',         'finance',    'Invoice approval with compliance check', ['P','E']],
  ['finance.budget',                   'finance',    'Budget entry & variance reporting', ['P','E']],
  ['finance.cash_handling',            'finance',    'Cash handling & donation-box tracking', ['P','E']],
  ['finance.statements',               'finance',    'Financial statements + board approval', ['P','E']],
  ['finance.bas_lodgement',            'finance',    'BAS / GST / PAYG quarterly workflow', ['P','E']],
  ['finance.month_end_checklist',      'finance',    'Month-end & year-end checklists', ['P','E']],
  ['finance.insurance_register',       'finance',    'Insurance tracking integration', ['P','E']],
  // Partner / People / AI — Professional + Enterprise
  ['partner.kyc_aml',                  'partner',    'KYC / AML / GDPR partner & donor vetting', ['P','E']],
  ['meeting.esignature',               'governance', 'Meeting minutes with e-signature', ['P','E']],
  ['auditor.read_only_access',         'governance', 'External auditor scoped read-only role', ['P','E']],
  ['ai.compliance_assistant',          'ai',         'OpenAI-backed AI compliance chatbot', ['P','E']],
  ['people.hr',                        'hr',         'Induction, offboarding, access revocation', ['P','E']],
  ['it.register',                      'operations', 'IT subscriptions & web admin register', ['P','E']],
  // Enterprise-only
  ['group.multi_entity',               'enterprise', 'Parent / subsidiary multi-entity management', ['E']],
  ['workflow.custom_builder',          'enterprise', 'No-code custom workflow builder', ['E']],
  ['governance.bcp_vault',             'enterprise', 'Business Continuity Plan vault', ['E']],
  ['security.credential_vault',        'enterprise', 'Secure Credential Vault', ['E']],
  ['governance.regulatory_radar',      'enterprise', 'AU + intl regulator change monitoring', ['E']],
  ['sso.saml_oidc',                    'security',   'SAML / OIDC single sign-on', ['E']],
  ['sso.scim',                         'security',   'SCIM user provisioning', ['E']],
  ['api.rest',                         'integration','Public REST API', ['E']],
  ['api.webhooks',                     'integration','Outbound webhooks', ['E']],
  ['branding.white_label',             'branding',   'Organisation branding on reports & portal', ['E']],
  ['data.residency_choice',            'compliance', 'AU primary / EU on request', ['E']],
  ['compliance.iso_soc2_pack',         'compliance', 'Compliance evidence pack', ['E']],
  ['support.dedicated_csm',            'support',    'Dedicated Customer Success Manager', ['E']],
  ['support.sla_99_9',                 'support',    'Contractual 99.9% uptime SLA', ['E']]
];

// Build the feature_flags map for a given tier letter from the catalogue above.
const flagsForTier = (tier) => {
  const map = {};
  for (const [code, , , tiers] of FLAGS) {
    map[code] = tiers.includes(tier);
  }
  return map;
};

// ── Plans (handbook §2.1 — tier matrix) ────────────────────────────────
const PLANS = [
  {
    plan_code: 'foundation',
    plan_name: 'Foundation',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 299,
      annualAUD: 2990,
      setupFeeMonthlyAUD: 500,
      setupFeeAnnualAUD: 0,
      overagePerWorkflowAUD: 2.00,
      currency: 'AUD',
      stripeProductId: '',
      stripeMonthlyPriceId: '',
      stripeAnnualPriceId: '',
      stripeOverageMeterId: ''
    },
    limits: {
      staffSeats: 5,
      boardSeats: 9,
      workflowsPerMonth: 50,
      storageGB: 10,
      apiCallsPerDay: 0,
      customWorkflows: 0,
      childEntities: 0,
      softCapPct: 80,
      hardCapPct: 100
    },
    feature_flags: flagsForTier('F'),
    support: { channel: 'email', responseSLAHours: 48, uptimeSLAPct: null },
    trial_days: 14,
    metadata: {
      description: 'Small charities ($50K–$1M)',
      targetCustomer: 'Small charities ($50K–$1M)',
      sortOrder: 10
    },
    // Legacy mirrors (kept in sync so any old reader still works).
    monthly_price: 299,
    yearly_price: 2990,
    is_active: true
  },
  {
    plan_code: 'professional',
    plan_name: 'Professional',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 1299,
      annualAUD: 12990,
      setupFeeMonthlyAUD: 2500,
      setupFeeAnnualAUD: 0,
      overagePerWorkflowAUD: 0.50,
      currency: 'AUD',
      stripeProductId: '',
      stripeMonthlyPriceId: '',
      stripeAnnualPriceId: '',
      stripeOverageMeterId: ''
    },
    limits: {
      staffSeats: 25,
      boardSeats: -1,        // unlimited
      workflowsPerMonth: 500,
      storageGB: 100,
      apiCallsPerDay: 0,
      customWorkflows: 0,
      childEntities: 0,
      softCapPct: 80,
      hardCapPct: 100
    },
    feature_flags: flagsForTier('P'),
    support: { channel: 'priority', responseSLAHours: 24, uptimeSLAPct: null },
    trial_days: 14,
    metadata: {
      description: 'Medium charities ($1M–$5M)',
      targetCustomer: 'Medium charities ($1M–$5M)',
      sortOrder: 20
    },
    monthly_price: 1299,
    yearly_price: 12990,
    is_active: true
  },
  {
    plan_code: 'enterprise',
    plan_name: 'Enterprise',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 4999,
      annualAUD: 49990,
      setupFeeMonthlyAUD: 10000,
      setupFeeAnnualAUD: 10000,
      overagePerWorkflowAUD: null,
      currency: 'AUD',
      stripeProductId: '',
      stripeMonthlyPriceId: '',
      stripeAnnualPriceId: '',
      stripeOverageMeterId: ''
    },
    limits: {
      staffSeats: -1,
      boardSeats: -1,
      workflowsPerMonth: -1,
      storageGB: -1,
      apiCallsPerDay: -1,
      customWorkflows: -1,
      childEntities: -1,
      softCapPct: 80,
      hardCapPct: 100
    },
    feature_flags: flagsForTier('E'),
    support: { channel: 'dedicated-csm', responseSLAHours: 4, uptimeSLAPct: 99.9 },
    trial_days: 0,
    metadata: {
      description: 'Large charities ($5M–$10M) / groups',
      targetCustomer: 'Large charities ($5M–$10M) / groups',
      sortOrder: 30
    },
    monthly_price: 4999,
    yearly_price: 49990,
    is_active: true
  }
];

const seed = async () => {
  await connectRouterDB();
  const { SubscriptionPlan, FeatureFlag, PlanRevision } = getRouterModels();

  // Feature flags first.
  let flagsUpserted = 0;
  for (const [code, category, name, ] of FLAGS) {
    await FeatureFlag.updateOne(
      { code },
      { $set: { code, category, name, status: 'active' } },
      { upsert: true }
    );
    flagsUpserted += 1;
  }
  logInfo(`Feature flags upserted: ${flagsUpserted}`);

  // Then plans, plus a seed PlanRevision per plan if none exist yet.
  let plansUpserted = 0;
  for (const planDoc of PLANS) {
    const existing = await SubscriptionPlan.findOne({ plan_code: planDoc.plan_code });
    if (existing) {
      // Patch new structured fields onto the existing doc without disturbing
      // any IDs Stripe may already point at.
      await SubscriptionPlan.updateOne(
        { _id: existing._id },
        { $set: { ...planDoc, current_revision: existing.current_revision || 1 } }
      );
    } else {
      const created = await SubscriptionPlan.create({ ...planDoc, current_revision: 1 });
      // Seed an initial revision so the History tab is never empty.
      await PlanRevision.create({
        plan_id: created._id,
        plan_code: created.plan_code,
        revision_number: 1,
        snapshot: created.toObject(),
        diff: [],
        reason: 'Initial catalogue seed.',
        changed_by: null,
        changed_at: new Date()
      });
    }
    plansUpserted += 1;
  }
  logInfo(`Plans upserted: ${plansUpserted}`);

  process.exit(0);
};

seed().catch((err) => {
  logError('Seed failed', err);
  process.exit(1);
});
