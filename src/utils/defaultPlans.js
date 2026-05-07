/**
 * Default plan templates — Foundation, Professional, Enterprise.
 *
 * These are the canonical plans from the Pricing Strategy Handbook (§2.1).
 * They are NOT seeded into the DB; instead the admin catalogue endpoints
 * merge them into responses so super-admins always see them in the UI.
 * Editing a template materialises it: a real SubscriptionPlan document
 * is created on first save with revision 1, and from then on the plan
 * lives in the DB.
 *
 * Same pattern as the checklist templates — code-defined defaults,
 * DB-backed overrides.
 */

// Feature flag catalogue — the 30+ gateable capabilities. Tier letters
// say which default plan(s) include the flag by default.
//   F = Foundation, P = Professional, E = Enterprise
export const DEFAULT_FEATURE_FLAGS = [
  // Governance — every tier
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

const flagsForTier = (tier) => {
  const map = {};
  for (const [code, , , tiers] of DEFAULT_FEATURE_FLAGS) map[code] = tiers.includes(tier);
  return map;
};

export const DEFAULT_PLANS = [
  {
    code: 'foundation',
    name: 'Foundation',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 299, annualAUD: 2990,
      setupFeeMonthlyAUD: 500, setupFeeAnnualAUD: 0,
      overagePerWorkflowAUD: 2.00, currency: 'AUD',
      stripeProductId: '', stripeMonthlyPriceId: '',
      stripeAnnualPriceId: '', stripeOverageMeterId: ''
    },
    limits: {
      staffSeats: 5, boardSeats: 9, workflowsPerMonth: 50,
      storageGB: 10, apiCallsPerDay: 0, customWorkflows: 0,
      childEntities: 0, softCapPct: 80, hardCapPct: 100
    },
    feature_flags: flagsForTier('F'),
    support: { channel: 'email', responseSLAHours: 48, uptimeSLAPct: null },
    trial_days: 14,
    metadata: {
      description: 'Small charities ($50K–$500K)',
      targetCustomer: 'Small charities ($50K–$500K)',
      sortOrder: 10
    }
  },
  {
    code: 'professional',
    name: 'Professional',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 1299, annualAUD: 12990,
      setupFeeMonthlyAUD: 2500, setupFeeAnnualAUD: 0,
      overagePerWorkflowAUD: 0.50, currency: 'AUD',
      stripeProductId: '', stripeMonthlyPriceId: '',
      stripeAnnualPriceId: '', stripeOverageMeterId: ''
    },
    limits: {
      staffSeats: 25, boardSeats: -1, workflowsPerMonth: 500,
      storageGB: 100, apiCallsPerDay: 0, customWorkflows: 0,
      childEntities: 0, softCapPct: 80, hardCapPct: 100
    },
    feature_flags: flagsForTier('P'),
    support: { channel: 'priority', responseSLAHours: 24, uptimeSLAPct: null },
    trial_days: 14,
    metadata: {
      description: 'Medium charities ($500K–$3M)',
      targetCustomer: 'Medium charities ($500K–$3M)',
      sortOrder: 20
    }
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 4999, annualAUD: 49990,
      setupFeeMonthlyAUD: 10000, setupFeeAnnualAUD: 10000,
      overagePerWorkflowAUD: null, currency: 'AUD',
      stripeProductId: '', stripeMonthlyPriceId: '',
      stripeAnnualPriceId: '', stripeOverageMeterId: ''
    },
    limits: {
      staffSeats: -1, boardSeats: -1, workflowsPerMonth: -1,
      storageGB: -1, apiCallsPerDay: -1, customWorkflows: -1,
      childEntities: -1, softCapPct: 80, hardCapPct: 100
    },
    feature_flags: flagsForTier('E'),
    support: { channel: 'dedicated-csm', responseSLAHours: 4, uptimeSLAPct: 99.9 },
    trial_days: 0,
    metadata: {
      description: 'Large charities ($3M+) / groups',
      targetCustomer: 'Large charities ($3M+) / groups',
      sortOrder: 30
    }
  }
];

/**
 * Merge a list of saved Plan documents (DB shape) with the in-code
 * templates. DB plans take priority; templates fill in any default
 * `code` that hasn't been materialised yet (returned with
 * is_template: true so the UI can label them).
 */
export function mergePlansWithTemplates(dbPlans = []) {
  const byCode = new Map();
  for (const p of dbPlans) byCode.set(String(p.plan_code || p.code).toLowerCase(), p);
  const templates = DEFAULT_PLANS
    .filter((d) => !byCode.has(d.code))
    .map((d) => ({ ...d, _id: null, is_template: true, current_revision: 0 }));
  const materialised = (dbPlans || []).map((p) => ({ ...p, is_template: false }));
  return [...materialised, ...templates]
    .sort((a, b) => (a?.metadata?.sortOrder ?? 999) - (b?.metadata?.sortOrder ?? 999));
}

export function findTemplateByCode(code) {
  return DEFAULT_PLANS.find((d) => d.code === String(code).toLowerCase()) || null;
}

export function feature_flags_default_map() {
  // Empty map — used when materialising a brand-new custom plan with no flags.
  const map = {};
  for (const [code] of DEFAULT_FEATURE_FLAGS) map[code] = false;
  return map;
}
