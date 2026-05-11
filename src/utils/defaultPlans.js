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

// Feature flag catalogue — single source of truth for every gateable
// capability. Tuple: [code, category, name, tiers, description, sidebar]
//   tiers   — F/P/E (Foundation/Professional/Enterprise) defaults
//   sidebar — array of sidebar nav labels this flag controls; empty = no
//             direct sidebar item (e.g. background capability like MFA)
export const DEFAULT_FEATURE_FLAGS = [
  // Governance — every tier
  ['governance.organisation',          'governance', 'Charity Administration',          ['F','P','E'], 'Responsible persons register, organisation chart, registrations & licenses, governing documents.', ['Charity Administration', 'Conflict of Interest', 'Legal Documents', 'Grants & Donors', 'Project Delivery', 'Marketing']],
  ['governance.board_portal',          'governance', 'Meetings & Board Portal',         ['F','P','E'], 'Schedule meetings, build agendas + packs, capture minutes and decisions.', ['Meetings']],
  ['governance.policy_management',     'governance', 'Policies & Procedures',           ['F','P','E'], 'Policy lifecycle — draft, publish, version, distribute and acknowledge.', ['Policies & Procedures']],
  ['governance.risk_register',         'governance', 'Risk Management',                 ['F','P','E'], 'Risk register, risk matrix, controls and treatment plans.', ['Risk Management']],
  ['governance.complaints',            'governance', 'Complaints Register',             ['F','P','E'], 'Receive complaints across channels, assign owners, track resolution.', ['Complaint']],
  ['governance.incidents',             'governance', 'Incidents Register',              ['F','P','E'], 'Log safeguarding / operational incidents and track follow-up actions.', []],
  ['governance.compliance_checklist',  'governance', 'Reporting & Compliance',          ['F','P','E'], 'ACNC Governance Standard 1–6 checklists and compliance reporting.', ['Reporting & Compliance', 'Weekly Reports']],
  ['governance.ais_workflow',          'governance', 'AIS Workflow',                    ['F','P','E'], 'Annual Information Statement preparation, board approval and ACNC submission.', []],
  // Security — every tier
  ['security.audit_log',               'security',   'Audit Trail',                     ['F','P','E'], 'Immutable record of every change made in the system, who and when.', ['Audit Trail']],
  ['security.mfa',                     'security',   'Multi-Factor Authentication',     ['F','P','E'], 'Time-based 6-digit codes on every login. Mandatory for org owners.', []],
  ['security.rbac',                    'security',   'Role-Based Permissions',          ['F','P','E'], 'Position-based permissions; staff only see what their role allows.', []],
  // Finance — Professional + Enterprise
  ['finance.expense_workflow',         'finance',    'Expense Workflows',               ['P','E'],     'Submit expenses, dual approval, attach receipts, audit trail.', ['Expenses']],
  ['finance.invoice_workflow',         'finance',    'Invoice Approvals',               ['P','E'],     'Supplier invoice intake, compliance check, multi-step approval.', []],
  ['finance.budget',                   'finance',    'Budgets & Variance',              ['P','E'],     'Budget entry, period roll-up, variance reporting against actuals.', []],
  ['finance.cash_handling',            'finance',    'Cash Handling & Sweep Funds',     ['P','E'],     'Donation box counting, sweep funds workflow with reconciliation.', ['Sweep Funds', 'Cash Handling', 'Refunds']],
  ['finance.statements',               'finance',    'Financial Controls',              ['P','E'],     'Financial controls register, statements, board approval workflow.', ['Financial Controls', 'Fiscal Reports']],
  ['finance.bas_lodgement',            'finance',    'BAS / GST / PAYG',                ['P','E'],     'Quarterly Business Activity Statement preparation and lodgement.', ['BAS Lodgement Report']],
  ['finance.month_end_checklist',      'finance',    'Month-end Checklist',             ['P','E'],     'Auto-generated month-end and year-end close checklists per fiscal calendar.', []],
  ['finance.insurance_register',       'finance',    'Insurance Register',              ['P','E'],     'Track policy renewals, premiums, certificates of currency.', ['Legal Documents → Insurance']],
  // Partner / People / AI — Professional + Enterprise
  ['partner.kyc_aml',                  'partner',    'Partner Vetting (KYC/AML)',       ['P','E'],     'Vet partners and donors via KYC / AML checks; capture COI declarations.', ['Project Delivery → Partner Vetting']],
  ['meeting.esignature',               'governance', 'Meeting E-Signature',             ['P','E'],     'Electronically sign meeting minutes — board / sub-committee.', []],
  ['auditor.read_only_access',         'governance', 'External Auditor Access',         ['P','E'],     'Time-limited read-only seat for an external auditor across modules.', []],
  ['ai.compliance_assistant',          'ai',         'AI Compliance Assistant',         ['P','E'],     'Floating chatbot that answers compliance questions using your data.', ['AI Chatbot widget']],
  ['people.hr',                        'hr',         'People & HR',                     ['P','E'],     'Employees, training register, induction, disciplinary records, offboarding.', ['People & HR', 'Volunteers', 'Access Control & Offboarding']],
  ['it.register',                      'operations', 'IT Systems Register',             ['P','E'],     'Track IT subscriptions, web admin accounts, MFA status, access logs.', ['IT System Register']],
  // Enterprise-only
  ['group.multi_entity',               'enterprise', 'Multi-entity Management',         ['E'],         'Parent / subsidiary structure with consolidated reporting.', []],
  ['workflow.custom_builder',          'enterprise', 'Custom Workflow Builder',         ['E'],         'No-code builder for custom approval flows beyond the defaults.', []],
  ['governance.bcp_vault',             'enterprise', 'Business Continuity Plan',        ['E'],         'BCP vault, emergency teams, recovery procedures, asset inventory.', ['Business Continuity']],
  ['security.credential_vault',        'enterprise', 'Credential Vault',                ['E'],         'Secure storage for org credentials with break-glass access controls.', []],
  ['governance.regulatory_radar',      'enterprise', 'Regulatory Radar',                ['E'],         'Australian + international regulator change monitoring with alerts.', []],
  ['sso.saml_oidc',                    'security',   'SAML / OIDC SSO',                 ['E'],         'Single sign-on via your identity provider (Okta, Azure AD, Google).', []],
  ['sso.scim',                         'security',   'SCIM Provisioning',               ['E'],         'Automatic user provisioning / deprovisioning from your IdP.', []],
  ['api.rest',                         'integration','Public REST API',                 ['E'],         'Authenticated REST API for custom integrations with your other tools.', []],
  ['api.webhooks',                     'integration','Outbound Webhooks',               ['E'],         'Subscribe to platform events; we POST them to your endpoints.', []],
  ['branding.white_label',             'branding',   'White-label Branding',            ['E'],         'Your logo & colours on the portal, exports, emails to staff and donors.', []],
  ['data.residency_choice',            'compliance', 'Data Residency Choice',           ['E'],         'Default AU; EU residency on request for international compliance.', []],
  ['compliance.iso_soc2_pack',         'compliance', 'Compliance Evidence Pack',        ['E'],         'Pre-built evidence pack for ISO 27001 / SOC2 audit responses.', []],
  ['support.dedicated_csm',            'support',    'Dedicated CSM',                   ['E'],         'Named Customer Success Manager with regular check-ins.', []],
  ['support.sla_99_9',                 'support',    'Contractual 99.9% SLA',           ['E'],         'Contractually guaranteed uptime with credits if missed.', []]
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
