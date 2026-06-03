/**
 * Default plan templates — Foundation, Professional, Enterprise, Bespoke.
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
//
// Naming rules (read like the Calcite ops AND the customer will both see
// these strings — anywhere a feature shows up, this is the wording):
//   - Names in plain English, no acronyms unless spelled out in brackets.
//   - Descriptions explain in one short sentence what the user gets, no
//     jargon (no "lifecycle", "RBAC", "SLA" without expansion).
//   - Spell out abbreviations the first time: MFA → "Two-Step Login",
//     SSO → "Single Sign-On", KYC/AML → "Identity & Anti-Money-Laundering",
//     SLA → "Uptime Guarantee", CSM → "Customer Success Manager".
//   - tiers   — F/P/E (Foundation/Professional/Enterprise) defaults
//   - sidebar — array of sidebar nav labels this flag controls; empty = no
//               direct sidebar item (e.g. background capability)
export const DEFAULT_FEATURE_FLAGS = [
  // Governance — every tier
  ['governance.organisation',          'governance', 'Charity Administration',                       ['F','P','E'], 'Responsible-people register, organisation chart, registrations and licences, and your governing documents.', ['Charity Administration', 'Conflict of Interest', 'Legal Documents', 'Grants & Donors', 'Project Delivery', 'Marketing']],
  ['governance.board_portal',          'governance', 'Meetings & Board Pack',                        ['F','P','E'], 'Schedule meetings, build agendas and board packs, capture minutes and decisions.', ['Meetings']],
  ['governance.policy_management',     'governance', 'Policies & Procedures',                        ['F','P','E'], 'Draft, publish, version, distribute and track who has acknowledged each policy.', ['Policies & Procedures']],
  ['governance.risk_register',         'governance', 'Risk Management',                              ['F','P','E'], 'Risk register, risk matrix, controls and treatment plans.', ['Risk Management']],
  ['governance.complaints',            'governance', 'Complaints Register',                          ['F','P','E'], 'Receive complaints from any channel, assign an owner, and track them through to resolution.', ['Complaint']],
  ['governance.incidents',             'governance', 'Incidents Register',                           ['F','P','E'], 'Log safeguarding and operational incidents and track follow-up actions.', []],
  ['governance.compliance_checklist',  'governance', 'Reporting & Compliance Checklists',            ['F','P','E'], 'Built-in checklists for ACNC Governance Standards 1–6 plus weekly compliance reports.', ['Reporting & Compliance', 'Weekly Reports']],
  ['governance.ais_workflow',          'governance', 'Annual Information Statement (AIS) Lodgement', ['F','P','E'], 'Prepare your AIS, get board approval, and submit it to the ACNC — all in one place.', []],
  // Security — every tier
  ['security.audit_log',               'security',   'Audit Trail',                                  ['F','P','E'], 'A tamper-proof record of every change made in the system — who did what and when.', ['Audit Trail']],
  ['security.mfa',                     'security',   'Two-Step Login (MFA)',                         ['F','P','E'], 'A 6-digit code from an authenticator app is required at every login. Required for owners.', []],
  ['security.rbac',                    'security',   'Position-Based Permissions',                   ['F','P','E'], 'Staff only see and edit what their position is allowed to. Permissions follow the role, not the person.', []],
  // Finance — Professional + Enterprise
  ['finance.expense_workflow',         'finance',    'Expense Claim Approvals',                      ['P','E'],     'Staff submit expenses, two-person approval, receipt attachments, full audit trail.', ['Expenses']],
  ['finance.invoice_workflow',         'finance',    'Supplier Invoice Approvals',                   ['P','E'],     'Capture supplier invoices, run compliance checks, and route through multi-step approval.', []],
  ['finance.budget',                   'finance',    'Budgets & Variance Tracking',                  ['P','E'],     'Enter budgets, roll them up by period, and report variance against actual spend.', []],
  ['finance.cash_handling',            'finance',    'Cash Handling & Sweep Funds',                  ['P','E'],     'Count donation boxes, sweep cash to the bank, reconcile the deposit — with proper dual-control.', ['Sweep Funds', 'Cash Handling', 'Refunds']],
  ['finance.statements',               'finance',    'Financial Controls & Statements',              ['P','E'],     'Financial controls register, generated statements, and board-approval workflow for finance documents.', ['Financial Controls', 'Fiscal Reports']],
  ['finance.bas_lodgement',            'finance',    'BAS, GST & PAYG Lodgement',                    ['P','E'],     'Prepare your quarterly Business Activity Statement (GST + PAYG) and lodge it with the ATO.', ['BAS Lodgement Report']],
  ['finance.month_end_checklist',      'finance',    'Month-End Closing Checklists',                 ['P','E'],     'Auto-generated month-end and year-end closing checklists tied to your fiscal calendar.', []],
  ['finance.insurance_register',       'finance',    'Insurance Register',                           ['P','E'],     'Track policy renewals, premiums, and certificates of currency in one place.', ['Legal Documents → Insurance']],
  // Partner / People / AI — Professional + Enterprise
  ['partner.kyc_aml',                  'partner',    'Partner & Donor Vetting',                      ['P','E'],     'Identity and anti-money-laundering checks on partners and donors, with conflict-of-interest declarations captured.', ['Project Delivery → Partner Vetting']],
  ['meeting.esignature',               'governance', 'Electronic Signing for Minutes',               ['P','E'],     'Board and sub-committee members can sign meeting minutes electronically.', []],
  ['auditor.read_only_access',         'governance', 'External Auditor Access',                      ['P','E'],     'Give an external auditor a time-limited, view-only seat that spans every module.', []],
  ['ai.compliance_assistant',          'ai',         'AI Compliance Assistant',                      ['P','E'],     'A chat assistant that answers compliance questions using your organisation\'s own data.', ['AI Chatbot widget']],
  ['people.hr',                        'hr',         'People & HR',                                  ['P','E'],     'Employees, training register, inductions, disciplinary records, volunteers, and offboarding in one module.', ['People & HR', 'Volunteers', 'Access Control & Offboarding']],
  ['it.register',                      'operations', 'Systems Register',                             ['P','E'],     'Track every IT subscription, admin account, two-step status, and access log.', ['Systems Register']],
  // Enterprise-only
  ['group.multi_entity',               'enterprise', 'Multi-Entity Management',                      ['E'],         'Manage a parent organisation and its subsidiaries together, with consolidated reporting.', []],
  ['workflow.custom_builder',          'enterprise', 'Custom Approval Workflow Builder',             ['E'],         'A no-code builder for approval flows beyond the ones that ship with the platform.', []],
  ['governance.bcp_vault',             'enterprise', 'Business Continuity Plan (BCP)',               ['E'],         'A vault for your continuity plan: emergency teams, recovery procedures, and an asset inventory.', ['Business Continuity']],
  ['security.credential_vault',        'enterprise', 'Shared Credential Vault',                      ['E'],         'Secure storage for organisation credentials, with "break-glass" emergency access controls.', []],
  ['governance.regulatory_radar',      'enterprise', 'Regulatory Change Monitoring',                 ['E'],         'Automatic alerts when Australian or international regulators publish changes that affect you.', []],
  ['sso.saml_oidc',                    'security',   'Single Sign-On (SAML / OIDC)',                 ['E'],         'Log in via your identity provider — Okta, Microsoft Entra ID, Google Workspace, or any SAML/OIDC vendor.', []],
  ['sso.scim',                         'security',   'Automatic User Provisioning (SCIM)',           ['E'],         'When you add or remove a user in your identity provider, their Stewardex access is created or revoked automatically.', []],
  ['api.rest',                         'integration','Developer API',                                ['E'],         'A secure REST API so your other tools can read and write Stewardex data.', []],
  ['api.webhooks',                     'integration','Webhook Notifications',                        ['E'],         'Subscribe to platform events — we POST them to your endpoint as they happen.', []],
  ['branding.white_label',             'branding',   'White-Label Branding',                         ['E'],         'Your logo and colours on the portal, exports, and outbound emails to staff and donors.', []],
  ['data.residency_choice',            'compliance', 'Choose Your Data Region',                      ['E'],         'Data lives in Australia by default; opt in to Europe (EU) hosting for international compliance.', []],
  ['compliance.iso_soc2_pack',         'compliance', 'ISO 27001 & SOC 2 Evidence Pack',              ['E'],         'A pre-built evidence pack covering ISO 27001 and SOC 2 audit responses — saves weeks of prep.', []],
  ['support.dedicated_csm',            'support',    'Dedicated Customer Success Manager',           ['E'],         'A named Customer Success Manager (CSM) with regular check-ins and a direct line for support.', []],
  ['support.sla_99_9',                 'support',    '99.9% Uptime Guarantee',                       ['E'],         'A contractual uptime promise of 99.9% — if we miss it, you get service credits back automatically.', []]
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
  },
  // ── Bespoke / Contact-Sales tier ───────────────────────────────────────
  // No public pricing. Pricing page renders this as the fourth horizontal
  // card with a "Contact support" CTA. Internally still gets every flag
  // (matches Enterprise) so a sales-closed deal flows through the same
  // entitlement engine as the priced tiers.
  {
    code: 'bespoke',
    name: 'Bespoke',
    visibility: 'public',
    status: 'active',
    pricing: {
      monthlyAUD: 0, annualAUD: 0,
      setupFeeMonthlyAUD: 0, setupFeeAnnualAUD: 0,
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
    support: { channel: 'dedicated-csm', responseSLAHours: 1, uptimeSLAPct: 99.95 },
    trial_days: 0,
    is_contact_sales: true,
    metadata: {
      description: 'Networks, federations and complex group structures — built to fit.',
      targetCustomer: 'Federations, peak bodies, multi-state groups',
      sortOrder: 40
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
