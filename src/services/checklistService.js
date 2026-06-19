import { getTenantConnection } from '../db/connectionManager.js';
import { ChecklistTemplateRepository } from '../repositories/checklistTemplateRepository.js';
import { ChecklistInstanceRepository } from '../repositories/checklistInstanceRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { RiskRepository } from '../repositories/riskRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';
import { COMPLIANCE_CHECKLIST_CATALOG } from '../config/complianceChecklistCatalog.js';
import { CHECKLIST_LIBRARY_V3, V3_LIBRARY_VERSION } from '../config/checklistLibraryV3.js';

// Per-tenant in-memory guards so the lazy auto-bootstrap runs at most once per
// process per tenant, and never concurrently (which could create duplicates).
const _bootstrappedVersionByOrg = new Map();
const _inflightBootstrapByOrg = new Map();
import { MONTHLY_COMPLIANCE_CATALOG } from '../config/monthlyComplianceCatalog.js';
import { MONTHLY_COMPLIANCE_RULES, evaluateMonthlyRule, monthWindow } from './monthlyComplianceRules.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHECKLIST_DICTIONARY_PATH = path.resolve(__dirname, '../../checklist/checklist_module_dictionary.json');
const CHECKLIST_SIDEBAR_DICTIONARY_PATH = path.resolve(__dirname, '../../checklist/checklist_module_dictionary_sidebar_sorted.json');

const SIDEBAR_SECTION_TO_MODULE = {
  'GOVERNANCE': 'Governance',
  'OPERATIONS': 'Operations',
  'FINANCES': 'Finance',
  'FUNDING': 'Funding',
  'REPORTING': 'Reporting',
  'System': 'System',
  'MAIN MENU': 'Main Menu'
};

function normalizeModuleName(value) {
  return String(value || '')
    .replace(/\+/g, ' ')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bpolicies\b/g, 'policy')
    .replace(/\bprocedures\b/g, 'procedure')
    // Singular/plural module-label synonyms. The V3 library labels finance
    // templates 'Finance' and the global complaints template 'Complaints',
    // while the entity-target maps use 'Finances' / 'Complaint'. Without these
    // the hard module filter in findBestTemplateForTarget rejects the correct
    // template and the entity gets NO checklist (or the wrong one).
    .replace(/\bfinances\b/g, 'finance')
    .replace(/\bcomplaints\b/g, 'complaint')
    .trim();
}

function toChecklistItemsFromStrings(items = [], category = 'General') {
  const dedupe = new Set();
  const out = [];
  let sortOrder = 10;
  for (const raw of Array.isArray(items) ? items : []) {
    const title = String(raw || '')
      .replace(/^[\u2610\u2611\u2713]\s*/, '')
      .replace(/^\d+(\.\d+)*\s*[\).:\-]?\s*/, '')
      .trim();
    if (!title || maybeChecklistHeading(title)) continue;
    const k = title.toLowerCase();
    if (dedupe.has(k)) continue;
    dedupe.add(k);
    out.push({
      title,
      description: `${category} compliance checklist item.`,
      category,
      requiredEvidence: 'optional',
      type: 'manual',
      assigneeRole: 'Compliance Officer',
      sortOrder
    });
    sortOrder += 10;
  }
  return out;
}

function flattenSidebarDictionaryNodes(parsed) {
  const rows = [];
  for (const [sectionName, sectionNode] of Object.entries(parsed || {})) {
    if (sectionName === '_meta' || !sectionNode || typeof sectionNode !== 'object') continue;
    const moduleLabel = SIDEBAR_SECTION_TO_MODULE[sectionName] || sectionName;

    // Support direct leaf sections where checklist items are defined at section level
    // e.g. "Policies & Procedures": { items: [...] }
    if (Array.isArray(sectionNode.items)) {
      rows.push({
        sectionName,
        moduleLabel,
        moduleName: sectionName,
        submoduleName: null,
        items: sectionNode.items
      });
      continue;
    }

    for (const [moduleName, moduleNode] of Object.entries(sectionNode || {})) {
      if (!moduleNode || typeof moduleNode !== 'object') continue;
      // Leaf module node with items
      if (Array.isArray(moduleNode.items)) {
        rows.push({
          sectionName,
          moduleLabel,
          moduleName,
          submoduleName: null,
          items: moduleNode.items
        });
        continue;
      }
      // Module with submodules
      for (const [submoduleName, subNode] of Object.entries(moduleNode || {})) {
        if (!subNode || typeof subNode !== 'object' || !Array.isArray(subNode.items)) continue;
        rows.push({
          sectionName,
          moduleLabel,
          moduleName,
          submoduleName,
          items: subNode.items
        });
      }
    }
  }
  return rows;
}

function maybeChecklistHeading(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^\d+(\.\d+)*\s*[\).:\-]?\s*$/.test(t)) return true;
  if (/^\d+(\.\d+)*\s+[A-Za-z].*$/.test(t) && t.length < 60 && !/[.?!]$/.test(t)) return true;
  if (/^sheet\d+\s+checklist$/i.test(t)) return true;
  return false;
}

function isRiskChecklistTitle(title) {
  const t = String(title || '').toLowerCase();
  return [
    'risk',
    'incident',
    'disaster recovery',
    'business continuity',
    'hazard',
    'treatment'
  ].some((kw) => t.includes(kw));
}

function looksRiskAction(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || maybeChecklistHeading(t)) return false;
  const exclude = [
    'policy is up to date',
    'effective date',
    'review date clearly stated',
    'approved by the designated authority',
    'distribute the policy',
    'board of directors',
    'work health and safety act',
    'privacy act',
    'australian standard'
  ];
  if (exclude.some((kw) => t.includes(kw))) return false;
  const include = [
    'risk', 'mitigat', 'control', 'incident', 'review', 'recovery', 'continuity',
    'disaster', 'hazard', 'treatment', 'assessment', 'register', 'escalation',
    'response', 'monitor', 'compliance'
  ];
  return include.some((kw) => t.includes(kw));
}

function buildRiskItemsFromDictionary() {
  try {
    if (!fs.existsSync(CHECKLIST_DICTIONARY_PATH)) return [];
    const raw = fs.readFileSync(CHECKLIST_DICTIONARY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const riskNode = parsed?.risk_management;
    const checklists = Array.isArray(riskNode?.checklists) ? riskNode.checklists : [];
    const dedupe = new Set();
    const out = [];
    let sortOrder = 10;
    for (const cl of checklists) {
      if (!isRiskChecklistTitle(cl?.title)) continue;
      const sections = cl?.sections || {};
      for (const [section, items] of Object.entries(sections)) {
        const safeCategory = String(section || 'General').trim().slice(0, 80) || 'General';
        for (const item of Array.isArray(items) ? items : []) {
          const title = String(item || '').trim();
          if (!looksRiskAction(title)) continue;
          const key = title.toLowerCase();
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          out.push({
            title,
            description: `Risk control check from policy checklist: ${safeCategory}.`,
            category: safeCategory,
            requiredEvidence: 'optional',
            type: 'manual',
            assigneeRole: 'Risk Officer',
            sortOrder
          });
          sortOrder += 10;
        }
      }
    }
    return out.slice(0, 60);
  } catch (err) {
    logError('Failed to build risk checklist items from dictionary', { error: err?.message });
    return [];
  }
}

function monthLabel(year, month) {
  const d = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return d.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', timeZone: 'UTC' });
}

function quarterLabel(year, quarter) {
  return `Q${quarter} ${year}`;
}

function computeDueDateForPeriod({ type, year, month, quarter }, offsetDays = 0) {
  const base = type === 'month_end'
    ? new Date(Date.UTC(year, (month || 1), 0, 23, 59, 59)) // last day of month
    : new Date(Date.UTC(year, ((Math.max(1, quarter) - 1) * 3) + 3, 0, 23, 59, 59)); // last day of quarter
  if (offsetDays) base.setUTCDate(base.getUTCDate() + Number(offsetDays));
  return base;
}

const ENTITY_MODULE_MAP = {
  expense: 'Finances',
  purchase: 'Finances',
  donation: 'Grants & Donors',
  donation_milestone: 'Grants & Donors',
  donor: 'Grants & Donors',
  grant: 'Grants & Donors',
  project: 'Grants & Donors',
  funding_agreement: 'Grants & Donors',
  partner: 'Grants & Donors',
  funding_partner: 'Grants & Donors',
  partner_vetting: 'Grants & Donors',
  // Suppliers use the SAME checklist as delivery partners (Partner Vetting), so
  // the supplier register shows the same due-diligence checklist.
  supplier: 'Grants & Donors',
  project_register: 'Grants & Donors',
  project_monitoring: 'Grants & Donors',
  refund: 'Grants & Donors',
  donor_refund: 'Grants & Donors',
  policy: 'Policies',
  risk: 'Risk',
  registration_license: 'Charity Administration',
  governing_document: 'Charity Administration',
  licence_document: 'Charity Administration',
  permit_document: 'Charity Administration',
  approval_thresholds: 'Charity Administration',
  yearly_statements: 'Charity Administration',
  financial_controls: 'Finances',
  responsible_person: 'Charity Administration',
  volunteer_person: 'Volunteers',
  hr_employee: 'People & HR',
  hr_training: 'People & HR',
  disciplinary_record: 'People & HR',
  donation_box: 'Finances',
  sweep_funds: 'Finances',
  bas_lodgement: 'Finance',
  financial_report: 'Reporting',
  fiscal_report: 'Reporting',
  complaint: 'Complaint',
  // 'System & Legal' matches no checklist template — route to the real modules.
  authority_transfer: 'BCP',
  social_media_campaign: 'Marketing',
  social_media_campaigns: 'Marketing',
  emergency: 'Finance',
  // Inquiry register records are ad-hoc, user-defined governance registers.
  inquiry_record: 'Governance'
};

const ENTITY_TEMPLATE_TARGETS = {
  expense: { module: 'Finances', submodule: 'Expenses' },
  purchase: { module: 'Finances', submodule: 'Expenses' },
  policy: { module: 'Policies' },
  risk: { module: 'Risk', submodule: 'Risk Management' },
  donor: { module: 'Grants & Donors', submodule: 'Donor Register' },
  // Project delivery → I13 (Project Monitoring), not the Programs templates
  // (I14/I35) which were tying and surfacing Community Sponsorship (#10).
  project: { module: 'Grants & Donors', submodule: 'Project Monitoring' },
  project_register: { module: 'Grants & Donors', submodule: 'Project Register' },
  project_monitoring: { module: 'Grants & Donors', submodule: 'Project Monitoring' },
  partner_vetting: { module: 'Grants & Donors', submodule: 'Partner Vetting' },
  partner: { module: 'Grants & Donors', submodule: 'Partner Vetting' },
  funding_partner: { module: 'Grants & Donors', submodule: 'Partner Vetting' },
  // Suppliers use the SAME checklist as Partner Vetting (delivery partners) — the
  // resolver picks the same Partner Vetting template for both.
  supplier: { module: 'Grants & Donors', submodule: 'Partner Vetting' },
  funding_agreement: { module: 'Grants & Donors', submodule: 'Funding Agreements' },
  // Refunds use the Finance/Refunds checklist (I05). Previously targeted
  // Grants & Donors/Refunds, which no template matches, so refunds showed no
  // (or the wrong) checklist.
  refund: { module: 'Finance', submodule: 'Refunds' },
  donor_refund: { module: 'Finance', submodule: 'Refunds' },
  project_refund: { module: 'Finance', submodule: 'Refunds' },
  registration_license: { module: 'Charity Administration', submodule: 'Registrations & Licenses' },
  governing_document: { module: 'Charity Administration', submodule: 'Governing Doc' },
  licence_document: { module: 'Charity Administration', submodule: 'Registrations & Licenses' },
  permit_document: { module: 'Charity Administration', submodule: 'Registrations & Licenses' },
  approval_thresholds: { module: 'Charity Administration', submodule: 'Approval Thresholds' },
  yearly_statements: { module: 'Charity Administration', submodule: 'Yearly Statements' },
  // #12 — Financial Controls is the Expenses area in this app; repoint it to
  // the Expenses checklist (I01) so the expense register drives it.
  financial_controls: { module: 'Finances', submodule: 'Expenses' },
  // Expense register-level Financial Record-Keeping checklist (I09, Sheet29) —
  // opened from a button on the Expenses register (#12).
  expense_register: { module: 'Finance', submodule: 'Records', useCase: 'expense_register' },
  // Bank/expense cards → I04; bank & platform access authorisations → I53 (#14).
  bank_card: { module: 'Finance', submodule: 'Financial Controls', useCase: 'bank_card' },
  bank_platform_access: { module: 'Finance', submodule: 'Financial Controls', useCase: 'bank_platform_access' },
  responsible_person: { module: 'Charity Administration', submodule: 'Responsible People' },
  // Volunteers carry three lifecycle checklists that share the same
  // module/submodule, disambiguated by useCase: onboarding (add) → I19,
  // register (ongoing) → I21, offboarding (inactivate) → I50.
  volunteer_person: { module: 'Volunteers', submodule: 'Volunteer Register', useCase: 'volunteer_register' },
  volunteer_register: { module: 'Volunteers', submodule: 'Volunteer Register', useCase: 'volunteer_register' },
  volunteer_onboarding: { module: 'Volunteers', submodule: 'Volunteer Register', useCase: 'volunteer_onboarding' },
  volunteer_offboarding: { module: 'Volunteers', submodule: 'Volunteer Register', useCase: 'volunteer_offboarding' },
  hr_employee: { module: 'People & HR', submodule: 'Employees' },
  hr_training: { module: 'People & HR', submodule: 'Trainings' },
  disciplinary_record: { module: 'People & HR', submodule: 'Disciplinary Records' },
  donation_box: { module: 'Finances', submodule: 'Donation Boxes' },
  sweep_funds: { module: 'Finances', submodule: 'Sweep Funds' },
  bas_lodgement: { module: 'Finance', submodule: 'BAS' },
  financial_report: { module: 'Reporting', submodule: 'Financial Reports' },
  fiscal_report: { module: 'Reporting', submodule: 'Fiscal Reports' },
  complaint: { module: 'Complaint', submodule: 'Complaint Register' },
  // Previously unmapped — these fell through to a module-only (wrong submodule)
  // or empty target and so attached an arbitrary/irrelevant checklist. Each
  // target below points at an existing V3 template's module + submodule.
  donation: { module: 'Grants & Donors', submodule: 'Donor Register' },
  donation_milestone: { module: 'Grants & Donors', submodule: 'Project Monitoring' },
  grant: { module: 'Grants & Donors', submodule: 'Funding Agreements' },
  // Business transfer / key-person continuity → Succession Plan (I54, Sheet81).
  authority_transfer: { module: 'BCP', submodule: 'Succession', useCase: 'business_transfer' },
  // Disaster Recovery & BCP plan → I55 (Sheet91).
  bcp_plan: { module: 'BCP', submodule: 'Business Continuity', useCase: 'bcp_plan' },
  emergency: { module: 'Finance', submodule: 'Emergency' },
  social_media_campaign: { module: 'Marketing', submodule: 'Campaigns' },
  social_media_campaigns: { module: 'Marketing', submodule: 'Campaigns' },
  // Marketing overall register checklist (I52, from Sheet43). Per-campaign
  // creation uses I27 (Marketing/Campaigns) instead.
  marketing_register: { module: 'Marketing', submodule: 'Register', useCase: 'marketing_register' },
  // Social media account access/credentials → I28 (Marketing/Social Media).
  social_media_account: { module: 'Marketing', submodule: 'Social Media', useCase: 'social_media_access' },
  // COI declarations → I25 (People & HR/Employees, useCase 'coi').
  coi: { module: 'People & HR', submodule: 'Employees', useCase: 'coi' },
  // External auditor onboarding/offboarding (#18) → I56 / I57.
  auditor_invite: { module: 'Audit', submodule: 'Auditors', useCase: 'auditor_onboarding' },
  auditor_offboarding: { module: 'Audit', submodule: 'Auditors', useCase: 'auditor_offboarding' },
  // Inquiry register records → dedicated Governance / Inquiries checklist
  // (I48 in checklistLibraryV3.js). Bootstrap the v3 library so it exists.
  inquiry_record: { module: 'Governance', submodule: 'Inquiries' }
};

function findBestTemplateForTarget(moduleTemplates = [], target = {}) {
  const requestedModule = normalizeModuleName(target?.module || '');
  const requestedSubmodule = normalizeModuleName(target?.submodule || '');
  const requestedUseCase = String(target?.useCase || '').trim().toLowerCase();

  // SAFEGUARD: with no usable target at all (an unmapped entity type — e.g. an
  // inquiry_record that isn't in ENTITY_MODULE_MAP / ENTITY_TEMPLATE_TARGETS),
  // never guess. Returning null means the workflow gets NO checklist rather
  // than an arbitrary, unrelated one (the caller handles null gracefully).
  if (!requestedModule && !requestedSubmodule && !requestedUseCase) return null;

  let best = null;
  let bestScore = 0;
  for (const tpl of moduleTemplates || []) {
    const moduleName = normalizeModuleName(tpl?.metadata?.module);
    const submoduleName = normalizeModuleName(tpl?.metadata?.submodule);
    const useCase = String(tpl?.metadata?.useCase || '').trim().toLowerCase();

    // Prevent cross-submodule bleed (e.g. Programs checklist showing on Funding Agreements).
    // If caller asks for a specific module/submodule, enforce exact match.
    if (requestedModule && moduleName !== requestedModule) continue;
    if (requestedSubmodule && submoduleName !== requestedSubmodule) continue;

    // Score ONLY real matches. is_active is a tie-break, never a qualifier —
    // otherwise an under-specified target would clear the bar on activeness
    // alone and return a confidently-wrong template.
    let matchScore = 0;
    if (requestedUseCase && useCase === requestedUseCase) matchScore += 6;
    if (requestedModule && moduleName === requestedModule) matchScore += 4;
    if (requestedSubmodule && submoduleName === requestedSubmodule) matchScore += 3;
    if (matchScore === 0) continue; // nothing actually matched this template

    const total = matchScore + (tpl?.is_active !== false ? 1 : 0);
    if (total > bestScore) {
      best = tpl;
      bestScore = total;
    }
  }
  // `best` is only ever set on a real module/submodule/useCase match.
  return best;
}

function doesTemplateMatchTarget(template, target = {}) {
  if (!template) return false;
  const requestedModule = normalizeModuleName(target?.module || '');
  const requestedSubmodule = normalizeModuleName(target?.submodule || '');
  const requestedUseCase = String(target?.useCase || '').trim().toLowerCase();
  const templateModule = normalizeModuleName(template?.metadata?.module);
  const templateSubmodule = normalizeModuleName(template?.metadata?.submodule);
  const templateUseCase = String(template?.metadata?.useCase || '').trim().toLowerCase();
  if (requestedUseCase && templateUseCase !== requestedUseCase) return false;
  if (requestedModule && templateModule !== requestedModule) return false;
  if (requestedSubmodule && templateSubmodule !== requestedSubmodule) return false;
  return true;
}

function canonicalizeEntityType(value) {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    sweep_funds_approval: 'sweep_funds',
    expense_approval: 'expense',
    fiscal_reports_workflow: 'fiscal_report',
    fiscal_report_workflow: 'fiscal_report',
    financial_reports_workflow: 'financial_report',
    financial_report_workflow: 'financial_report',
    risk_management: 'risk',
    financial_controls: 'expense',
    donation_boxes: 'donation_box',
    project_delivery: 'project_monitoring',
    refunds: 'refund',
    partner: 'partner_vetting',
    funding_partner: 'partner_vetting',
    partner_vetting_record: 'partner_vetting',
    fundingagreement: 'funding_agreement',
    funding_agreements: 'funding_agreement',
    agreement: 'funding_agreement',
    project_register_entry: 'project_register',
    projectmonitoring: 'project_monitoring',
    project_refund: 'refund'
    ,
    bas: 'bas_lodgement',
    financial_reports: 'financial_report',
    financial_reporting: 'financial_report',
    fiscal_reports: 'fiscal_report',
    fiscal_report_monthly: 'fiscal_report',
    fiscal_report_yearly: 'fiscal_report'
  };
  return aliases[raw] || raw;
}

function isGenericEntityType(value) {
  const t = String(value || '').trim().toLowerCase();
  // 'document' is a wrapper type used by document-driven approval requests
  // (BAS, fiscal_report). The real semantic type lives on request_type, so
  // treat it as generic to force resolution from request_type.
  return !t || t === 'other' || t === 'unknown' || t === 'generic' || t === 'document';
}

function isApprovalScopedChecklistType(entityType) {
  const t = String(entityType || '').trim().toLowerCase();
  return t === 'sweep_funds';
}

export class ChecklistService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async getTenantDb() {
    return await getTenantConnection(this.orgId);
  }

  async ensureDefaultMonthEndTemplate() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = await templateRepo.findActiveByType(this.orgId, 'month_end');
    if (existing) return existing;

    const template = await templateRepo.create({
      org_id: this.orgId,
      name: 'Month-end Financial Close',
      type: 'month_end',
      description: 'End-of-month finance close checklist.',
      items: [
        { title: 'Bank reconciliation', description: 'Reconcile all bank accounts and investigate variances.', category: 'Reconciliation', requiredEvidence: 'required', assigneeRole: 'Finance Officer', sortOrder: 10 },
        { title: 'Accounts receivable (AR) review', description: 'Review outstanding receivables and follow up where needed.', category: 'AR/AP', requiredEvidence: 'optional', assigneeRole: 'Finance Officer', sortOrder: 20 },
        { title: 'Accounts payable (AP) review', description: 'Review payable aging and ensure invoices are recorded correctly.', category: 'AR/AP', requiredEvidence: 'optional', assigneeRole: 'Finance Officer', sortOrder: 30 },
        { title: 'Accruals posting', description: 'Post accruals for incurred expenses not yet invoiced.', category: 'Close', requiredEvidence: 'required', assigneeRole: 'Finance Manager', sortOrder: 40 },
        { title: 'Depreciation calculation', description: 'Calculate and post depreciation entries.', category: 'Close', requiredEvidence: 'required', assigneeRole: 'Finance Manager', sortOrder: 50 },
        { title: 'Payroll reconciliation', description: 'Reconcile payroll registers to general ledger and bank.', category: 'Reconciliation', requiredEvidence: 'required', assigneeRole: 'Finance Officer', sortOrder: 60 },
        { title: 'Final trial balance review', description: 'Confirm trial balance balances and anomalies are explained.', category: 'Review', requiredEvidence: 'required', assigneeRole: 'Finance Manager', sortOrder: 70 }
      ]
    });

    logInfo('Created default month-end checklist template', { orgId: this.orgId, templateId: template._id });
    return template;
  }

  async ensureDefaultQuarterEndTemplate() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = await templateRepo.findActiveByType(this.orgId, 'quarter_end');
    if (existing) return existing;

    const template = await templateRepo.create({
      org_id: this.orgId,
      name: 'Quarter-end Financial Review',
      type: 'quarter_end',
      description: 'Quarter-end review and sign-off.',
      items: [
        { title: 'Quarterly reconciliation roll-up', description: 'Validate reconciliations across the quarter.', category: 'Reconciliation', requiredEvidence: 'required', assigneeRole: 'Finance Manager', sortOrder: 10 },
        { title: 'Quarterly accruals + provisions review', description: 'Review accruals/provisions for completeness.', category: 'Close', requiredEvidence: 'required', assigneeRole: 'Finance Manager', sortOrder: 20 },
        { title: 'Quarterly management review', description: 'Review quarter results and exceptions.', category: 'Review', requiredEvidence: 'required', assigneeRole: 'Finance Manager', sortOrder: 30 }
      ]
    });
    logInfo('Created default quarter-end checklist template', { orgId: this.orgId, templateId: template._id });
    return template;
  }

  async ensureDefaultExpenseWorkflowTemplate() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = (await templateRepo.list(this.orgId, { type: 'module', module: 'Finance' }))
      .find((t) => t?.metadata?.useCase === 'expense_workflow' || String(t?.name || '').toLowerCase() === 'expense workflow compliance checklist');
    if (existing) return existing;

    const template = await templateRepo.create({
      org_id: this.orgId,
      name: 'Expense Workflow Compliance Checklist',
      type: 'module',
      description: 'Checklist attached to each expense approval workflow.',
      metadata: { module: 'Finance', useCase: 'expense_workflow' },
      items: [
        { title: 'Invoice attached', description: 'Expense invoice document is attached and readable.', category: 'Documents', requiredEvidence: 'none', type: 'auto', assigneeRole: 'Finance Officer', sortOrder: 10, autoRuleKey: 'EXPENSE.INVOICE_ATTACHED' },
        { title: 'Supplier details verified', description: 'Supplier name and details are complete and accurate.', category: 'Validation', requiredEvidence: 'none', type: 'auto', assigneeRole: 'Finance Officer', sortOrder: 20, autoRuleKey: 'EXPENSE.SUPPLIER_FIELDS_PRESENT' },
        { title: 'Approval routing correct', description: 'Approval workflow and signatories are assigned correctly.', category: 'Workflow', requiredEvidence: 'none', type: 'auto', assigneeRole: 'Finance Manager', sortOrder: 30, autoRuleKey: 'EXPENSE.APPROVAL_ROUTING_PRESENT' },
        { title: 'Payment proof captured', description: 'Payment proof uploaded where applicable.', category: 'Payment', requiredEvidence: 'none', type: 'auto', assigneeRole: 'Finance Officer', sortOrder: 40, autoRuleKey: 'EXPENSE.PAYMENT_PROOF_PRESENT' },
        { title: 'Dual-signatory trail complete', description: 'Processor, co-signatory and signing officer trail is present when payment is reviewed.', category: 'Payment', requiredEvidence: 'none', type: 'auto', assigneeRole: 'Finance Manager', sortOrder: 50, autoRuleKey: 'EXPENSE.DUAL_TRAIL_PRESENT' }
      ]
    });

    logInfo('Created default expense workflow checklist template', { orgId: this.orgId, templateId: template._id });
    return template;
  }

  /**
   * Lazily ensure the dedicated inquiry-register checklist template (V3 I48)
   * exists for this tenant. Inquiry workflows resolve a checklist on every
   * approval view, but the v3 library is only bootstrapped on demand — so a
   * tenant provisioned before I48 shipped would otherwise have no inquiry
   * template and fall back to an unrelated checklist. Sourced from the V3
   * definition so item text has a single source of truth.
   */
  async ensureDefaultInquiryWorkflowTemplate() {
    const def = CHECKLIST_LIBRARY_V3.find((c) => c.v3Id === 'I48');
    if (!def) return null;
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = (await templateRepo.list(this.orgId, {}))
      .find((t) => t?.metadata?.v3_checklist_id === 'I48');
    if (existing) return existing;

    const created = await templateRepo.create({
      org_id: this.orgId,
      name: `[${def.v3Id}] ${def.name}`,
      type: 'module',
      description: def.description,
      metadata: {
        module: def.module,
        submodule: def.submodule,
        v3_checklist_id: def.v3Id,
        v3Type: def.checklistType,
        v3Category: def.category,
        v3Version: '3.0',
        entityTargets: def.entityTargets || [],
        source: 'checklist_library_v3'
      },
      items: (def.items || []).map((it) => ({
        title: it.title,
        description: `${def.category} compliance check — ${def.name}.`,
        category: def.category,
        type: 'manual',
        requiredEvidence: 'optional',
        assigneeRole: 'Compliance Officer',
        sortOrder: it.sortOrder
      }))
    });
    logInfo('Created default inquiry workflow checklist template', { orgId: this.orgId, templateId: created._id });
    return created;
  }

  /**
   * Lazily ensure the dedicated supplier-vetting checklist template (V3 I49)
   * exists for this tenant. Mirrors the inquiry case: supplier vetting workflows
   * resolve a checklist on every approval view, but the v3 library is only
   * bootstrapped on demand — so a tenant provisioned before I49 shipped would
   * otherwise have no supplier template and fall back to an unrelated checklist
   * (e.g. the inquiry-register checklist). Sourced from the V3 definition so item
   * text has a single source of truth.
   */
  async ensureDefaultSupplierWorkflowTemplate() {
    const def = CHECKLIST_LIBRARY_V3.find((c) => c.v3Id === 'I49');
    if (!def) return null;
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = (await templateRepo.list(this.orgId, {}))
      .find((t) => t?.metadata?.v3_checklist_id === 'I49');
    if (existing) return existing;

    const created = await templateRepo.create({
      org_id: this.orgId,
      name: `[${def.v3Id}] ${def.name}`,
      type: 'module',
      description: def.description,
      metadata: {
        module: def.module,
        submodule: def.submodule,
        v3_checklist_id: def.v3Id,
        v3Type: def.checklistType,
        v3Category: def.category,
        v3Version: '3.0',
        entityTargets: def.entityTargets || [],
        source: 'checklist_library_v3'
      },
      items: (def.items || []).map((it) => ({
        title: it.title,
        description: `${def.category} compliance check — ${def.name}.`,
        category: def.category,
        type: 'manual',
        requiredEvidence: 'optional',
        assigneeRole: 'Compliance Officer',
        sortOrder: it.sortOrder
      }))
    });
    logInfo('Created default supplier workflow checklist template', { orgId: this.orgId, templateId: created._id });
    return created;
  }

  async ensureDefaultRiskWorkflowTemplate() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = (await templateRepo.list(this.orgId, { type: 'module', module: 'Compliance' }))
      .find((t) => t?.metadata?.useCase === 'risk_workflow' || String(t?.name || '').toLowerCase() === 'risk workflow compliance checklist');
    const fallbackRiskItems = [
      {
        title: 'Risk owner assigned',
        description: 'A responsible risk owner or responsible person is assigned.',
        category: 'Risk Identification',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Officer',
        sortOrder: 10,
        autoRuleKey: 'RISK.OWNER_ASSIGNED'
      },
      {
        title: 'Risk category and impact context documented',
        description: 'Risk statement, impact and context are documented clearly for review.',
        category: 'Risk Identification',
        requiredEvidence: 'optional',
        type: 'manual',
        assigneeRole: 'Risk Officer',
        sortOrder: 20
      },
      {
        title: 'Risk attachment uploaded',
        description: 'At least one supporting document is attached to the risk.',
        category: 'Evidence & Documentation',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Officer',
        sortOrder: 30,
        autoRuleKey: 'RISK.ATTACHMENT_PRESENT'
      },
      {
        title: 'Controls and assumptions documented',
        description: 'Current controls and key assumptions are documented for auditability.',
        category: 'Evidence & Documentation',
        requiredEvidence: 'optional',
        type: 'manual',
        assigneeRole: 'Risk Owner',
        sortOrder: 40
      },
      {
        title: 'Treatment workflow progressed',
        description: 'At least one treatment/control action is captured and tracked.',
        category: 'Treatment & Controls',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Owner',
        sortOrder: 50,
        autoRuleKey: 'RISK.TREATMENT_CAPTURED'
      },
      {
        title: 'Treatment owner and due dates confirmed',
        description: 'Treatment action owners and timelines are confirmed and realistic.',
        category: 'Treatment & Controls',
        requiredEvidence: 'optional',
        type: 'manual',
        assigneeRole: 'Risk Owner',
        sortOrder: 60
      },
      {
        title: 'Next review date set',
        description: 'A future next review date is configured for follow-up.',
        category: 'Monitoring & Review',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Officer',
        sortOrder: 70,
        autoRuleKey: 'RISK.NEXT_REVIEW_DATE_SET'
      },
      {
        title: 'Escalation path and triggers confirmed',
        description: 'Escalation triggers and response path are documented and understood.',
        category: 'Monitoring & Review',
        requiredEvidence: 'optional',
        type: 'manual',
        assigneeRole: 'Compliance Officer',
        sortOrder: 80
      },
      {
        title: 'Responsible people compliance confirmed',
        description: 'Responsible people have reviewed and confirmed compliance obligations.',
        category: 'Governance & Compliance',
        requiredEvidence: 'optional',
        type: 'manual',
        assigneeRole: 'Board Member',
        sortOrder: 90
      },
      {
        title: 'Privacy and regulatory obligations confirmed',
        description: 'Privacy and applicable regulatory requirements are considered for this risk.',
        category: 'Governance & Compliance',
        requiredEvidence: 'optional',
        type: 'manual',
        assigneeRole: 'Compliance Officer',
        sortOrder: 100
      }
    ];
    const dictionaryRiskItems = buildRiskItemsFromDictionary();
    const riskItems = dictionaryRiskItems.length > 0 ? dictionaryRiskItems : fallbackRiskItems;
    const autoRules = [
      {
        title: 'Risk owner assigned',
        description: 'A responsible risk owner or responsible person is assigned.',
        category: 'Risk Identification',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Officer',
        sortOrder: 1,
        autoRuleKey: 'RISK.OWNER_ASSIGNED'
      },
      {
        title: 'Risk attachment uploaded',
        description: 'At least one supporting document is attached to the risk.',
        category: 'Evidence & Documentation',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Officer',
        sortOrder: 2,
        autoRuleKey: 'RISK.ATTACHMENT_PRESENT'
      },
      {
        title: 'Treatment workflow progressed',
        description: 'At least one treatment/control action is captured and tracked.',
        category: 'Treatment & Controls',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Owner',
        sortOrder: 3,
        autoRuleKey: 'RISK.TREATMENT_CAPTURED'
      },
      {
        title: 'Next review date set',
        description: 'A future next review date is configured for follow-up.',
        category: 'Monitoring & Review',
        requiredEvidence: 'none',
        type: 'auto',
        assigneeRole: 'Risk Officer',
        sortOrder: 4,
        autoRuleKey: 'RISK.NEXT_REVIEW_DATE_SET'
      }
    ];
    const mergedRiskItems = [
      ...autoRules,
      ...riskItems
        .filter((it) => !autoRules.some((a) => a.title.toLowerCase() === String(it.title || '').toLowerCase()))
        .map((it, idx) => ({ ...it, sortOrder: (idx + 1) * 10 + 100 }))
    ];
    if (existing) {
      const updated = await templateRepo.update(existing._id, {
        description: 'Checklist attached to each risk workflow lifecycle.',
        metadata: { ...(existing.metadata || {}), module: 'Compliance', useCase: 'risk_workflow', version: '2026-04-14' },
        items: mergedRiskItems
      });
      return updated || await templateRepo.findById(existing._id);
    }

    const template = await templateRepo.create({
      org_id: this.orgId,
      name: 'Risk Workflow Compliance Checklist',
      type: 'module',
      description: 'Checklist attached to each risk workflow lifecycle.',
      metadata: { module: 'Compliance', useCase: 'risk_workflow' },
      items: mergedRiskItems
    });

    logInfo('Created default risk workflow checklist template', { orgId: this.orgId, templateId: template._id });
    return template;
  }

  async syncSidebarDictionaryTemplates() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    try {
      if (!fs.existsSync(CHECKLIST_SIDEBAR_DICTIONARY_PATH)) return [];
      const raw = fs.readFileSync(CHECKLIST_SIDEBAR_DICTIONARY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      const nodes = flattenSidebarDictionaryNodes(parsed);
      const summary = [];

      for (const node of nodes) {
        const category = node.submoduleName || node.moduleName || 'General';
        const templateItems = toChecklistItemsFromStrings(node.items, category);
        if (templateItems.length === 0) continue;

        const templateName = node.submoduleName
          ? `${node.moduleName} - ${node.submoduleName} Compliance Checklist`
          : `${node.moduleName} Compliance Checklist`;

        const existing = (await templateRepo.list(this.orgId, { type: 'module', module: node.moduleLabel }))
          .find((t) =>
            String(t?.name || '').toLowerCase() === templateName.toLowerCase() ||
            (
              t?.metadata?.source === 'sidebar_dictionary' &&
              String(t?.metadata?.sidebarSection || '') === String(node.sectionName) &&
              String(t?.metadata?.sidebarModule || '') === String(node.moduleName) &&
              String(t?.metadata?.sidebarSubmodule || '') === String(node.submoduleName || '')
            )
          );

        const payload = {
          name: templateName,
          type: 'module',
          description: `Dictionary-backed checklist for ${node.moduleName}${node.submoduleName ? ` / ${node.submoduleName}` : ''}.`,
          metadata: {
            module: node.moduleLabel,
            source: 'sidebar_dictionary',
            sidebarSection: node.sectionName,
            sidebarModule: node.moduleName,
            sidebarSubmodule: node.submoduleName || null,
            dictionaryVersion: '2026-04-14'
          },
          items: templateItems
        };

        if (existing) {
          await templateRepo.update(existing._id, payload);
          summary.push({ action: 'updated', templateId: existing._id, name: templateName, itemCount: templateItems.length });
        } else {
          const created = await templateRepo.create({ org_id: this.orgId, ...payload });
          summary.push({ action: 'created', templateId: created._id, name: templateName, itemCount: templateItems.length });
        }
      }
      return summary;
    } catch (err) {
      logError('Failed to sync sidebar dictionary templates', { error: err?.message });
      return [];
    }
  }

  async bootstrapComplianceCatalogTemplates() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);

    const grouped = COMPLIANCE_CHECKLIST_CATALOG.reduce((acc, it) => {
      const key = it.module || 'General';
      if (!acc[key]) acc[key] = [];
      acc[key].push(it);
      return acc;
    }, {});

    const summary = [];
    for (const [moduleName, items] of Object.entries(grouped)) {
      const name = `${moduleName} Compliance Checklist`;
      const existing = (await templateRepo.list(this.orgId, { type: 'module', module: moduleName }))
        .find((t) => String(t.name || '').toLowerCase() === name.toLowerCase());

      const templateItems = items.map((it, idx) => ({
        title: it.title,
        description: `${it.title} compliance check for ${moduleName} module.`,
        category: it.category || 'General',
        type: 'manual',
        requiredEvidence: 'optional',
        assigneeRole: 'Compliance Officer',
        sortOrder: (idx + 1) * 10
      }));

      if (existing) {
        await templateRepo.update(existing._id, {
          description: `Module-wide checklist for ${moduleName} screens and workflows.`,
          metadata: { ...(existing.metadata || {}), module: moduleName, catalogVersion: '2026-04-10' },
          items: templateItems
        });
        summary.push({ module: moduleName, templateId: existing._id, action: 'updated', itemCount: templateItems.length });
      } else {
        const created = await templateRepo.create({
          org_id: this.orgId,
          name,
          type: 'module',
          description: `Module-wide checklist for ${moduleName} screens and workflows.`,
          metadata: { module: moduleName, catalogVersion: '2026-04-10' },
          items: templateItems
        });
        summary.push({ module: moduleName, templateId: created._id, action: 'created', itemCount: templateItems.length });
      }
    }

    logInfo('Bootstrapped module-wise compliance checklist templates', {
      orgId: this.orgId,
      templateCount: summary.length
    });
    return summary;
  }

  /**
   * Lazily auto-bootstrap the V3 library for this tenant when the stored
   * version differs from the current code version. Runs at most once per
   * process per tenant, never concurrently. Best-effort — never throws into
   * the caller (a bootstrap failure must not break a checklist request).
   *
   * This removes the need to ever click "Load default checklists" manually:
   * a backend restart + the next checklist request applies all library edits.
   */
  async ensureV3Bootstrapped() {
    const orgId = this.orgId;
    if (_bootstrappedVersionByOrg.get(orgId) === V3_LIBRARY_VERSION) return;
    if (_inflightBootstrapByOrg.has(orgId)) return _inflightBootstrapByOrg.get(orgId);

    const run = (async () => {
      try {
        const tenantDb = await this.getTenantDb();
        const metaCol = tenantDb.collection('checklist_meta');
        const meta = await metaCol.findOne({ key: 'v3_library_version' });
        if (meta?.value === V3_LIBRARY_VERSION) {
          _bootstrappedVersionByOrg.set(orgId, V3_LIBRARY_VERSION);
          return;
        }
        await this.bootstrapV3Library();
        await metaCol.updateOne(
          { key: 'v3_library_version' },
          { $set: { key: 'v3_library_version', value: V3_LIBRARY_VERSION, updated_at: new Date() } },
          { upsert: true }
        );
        _bootstrappedVersionByOrg.set(orgId, V3_LIBRARY_VERSION);
        logInfo('Auto-bootstrapped v3 checklist library', { orgId, version: V3_LIBRARY_VERSION });
      } catch (err) {
        logError('Auto-bootstrap of v3 library failed', { orgId, error: err?.message });
      } finally {
        _inflightBootstrapByOrg.delete(orgId);
      }
    })();
    _inflightBootstrapByOrg.set(orgId, run);
    return run;
  }

  /**
   * Bootstrap v3 Optimised Checklist Library (50 checklists from xlsx).
   *
   * Idempotent: uses metadata.v3_checklist_id (G01–G10, I01–I40) as the
   * dedup key. Re-running updates items and metadata without duplicating.
   *
   * Global checklists (G01–G10) are stored as type='module' with
   * metadata.v3Type='global'. They apply across all modules as governance
   * overlays.
   *
   * Item-wise checklists (I01–I40) are stored as type='module' (or the
   * period type for I06/I07) with metadata.v3Type='item_wise' and are
   * bound to specific entity targets.
   */
  async bootstrapV3Library() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const summary = [];

    // Pre-fetch all existing module templates for this org once
    const allExisting = await templateRepo.list(this.orgId, {});

    for (const cl of CHECKLIST_LIBRARY_V3) {
      const v3Id = cl.v3Id;
      const templateName = `[${v3Id}] ${cl.name}`;

      // Determine template type: I06→month_end, I07→year_end, rest→module
      const templateType = cl.periodType || 'module';

      // Build items array with standard shape
      const templateItems = (cl.items || []).map((it) => ({
        title: it.title,
        description: `${cl.category} compliance check — ${cl.name}.`,
        category: it.category || cl.category,
        type: 'manual',
        requiredEvidence: 'optional',
        assigneeRole: 'Compliance Officer',
        sortOrder: it.sortOrder
      }));

      if (templateItems.length === 0) continue;

      // Build metadata
      const metadata = {
        module: cl.module,
        ...(cl.submodule ? { submodule: cl.submodule } : {}),
        ...(cl.useCase ? { useCase: cl.useCase } : {}),
        v3_checklist_id: v3Id,
        v3Type: cl.checklistType,
        v3Category: cl.category,
        v3Version: '3.0',
        entityTargets: cl.entityTargets || [],
        source: 'checklist_library_v3'
      };

      // Find existing by v3_checklist_id (idempotent key)
      const existing = allExisting.find(
        (t) => t?.metadata?.v3_checklist_id === v3Id
      );

      if (existing) {
        await templateRepo.update(existing._id, {
          name: templateName,
          type: templateType,
          description: cl.description,
          metadata: { ...(existing.metadata || {}), ...metadata },
          items: templateItems
        });
        summary.push({
          v3Id,
          action: 'updated',
          templateId: existing._id,
          name: templateName,
          itemCount: templateItems.length,
          type: cl.checklistType
        });
      } else {
        const created = await templateRepo.create({
          org_id: this.orgId,
          name: templateName,
          type: templateType,
          description: cl.description,
          metadata,
          items: templateItems
        });
        summary.push({
          v3Id,
          action: 'created',
          templateId: created._id,
          name: templateName,
          itemCount: templateItems.length,
          type: cl.checklistType
        });
      }
    }

    logInfo('Bootstrapped v3 checklist library', {
      orgId: this.orgId,
      total: summary.length,
      created: summary.filter((s) => s.action === 'created').length,
      updated: summary.filter((s) => s.action === 'updated').length
    });
    return summary;
  }

  async ensureWorkflowChecklistForApproval({ entityType, entityId, approvalRequestId, createdBy }) {
    await this.ensureV3Bootstrapped();
    const rawEntityType = String(entityType || '').trim().toLowerCase();
    let normalizedEntityType = canonicalizeEntityType(rawEntityType);
    let normalizedEntityId = String(entityId || '').trim();

    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const instanceRepo = new ChecklistInstanceRepository(tenantDb);
    const approvalRepo = new ApprovalRequestRepository(tenantDb);

    // Some workflow pages only have approvalRequestId or use entity type aliases.
    // Derive canonical context from approval request when needed so one instance is reused.
    if (approvalRequestId) {
      const approval = await approvalRepo.findById(approvalRequestId);
      if (approval) {
        const approvalEntityTypeRaw = String(approval?.entity_type || '').trim().toLowerCase();
        const approvalRequestTypeRaw = String(approval?.request_type || '').trim().toLowerCase();
        const derivedFromApproval = canonicalizeEntityType(
          isGenericEntityType(approvalEntityTypeRaw)
            ? (approvalRequestTypeRaw || normalizedEntityType)
            : (approvalEntityTypeRaw || approvalRequestTypeRaw || normalizedEntityType)
        );
        const derivedEntityId = String(approval?.entity_id || '').trim();

        // If caller sends generic/incorrect type (e.g. "other"), prefer approval context.
        if (isGenericEntityType(normalizedEntityType) || !normalizedEntityType) {
          normalizedEntityType = derivedFromApproval;
        }
        if (!normalizedEntityId || isGenericEntityType(rawEntityType)) {
          normalizedEntityId = derivedEntityId || normalizedEntityId;
        }

        // Special case: some workflows use request_type as the true domain type.
        if (
          approval?.request_type &&
          (normalizedEntityType === 'other' || isGenericEntityType(normalizedEntityType))
        ) {
          normalizedEntityType = canonicalizeEntityType(approval.request_type);
        }

        // Some workflows are approval-scoped rather than entity-scoped. For those,
        // the approval request id is the only stable identifier across create/view/workflow.
        if (
          approvalRequestId &&
          isGenericEntityType(approvalEntityTypeRaw) &&
          isApprovalScopedChecklistType(normalizedEntityType)
        ) {
          normalizedEntityId = String(approval?._id || approvalRequestId);
        }
      }
    }
    if (!normalizedEntityType || !normalizedEntityId) {
      throw new AppError('entityType and entityId are required', 400, 'INVALID_WORKFLOW_CONTEXT');
    }

    // Inquiry workflows use a dedicated checklist (V3 I48). Ensure it exists for
    // this tenant even if the v3 library bootstrap hasn't been re-run, so inquiry
    // records get their own checklist instead of an unrelated fallback. Existing
    // stale instances self-heal: once this template is found, the existing-
    // instance branch below swaps its items to the correct ones.
    if (normalizedEntityType === 'inquiry_record') {
      await this.ensureDefaultInquiryWorkflowTemplate();
    }
    // Suppliers reuse the Partner Vetting checklist (V3 I15–I17, seeded by the V3
    // bootstrap above). `supplier` targets Grants & Donors / Partner Vetting, so
    // the resolver picks the same template delivery-partner vetting uses.

    const allModuleTemplates = await templateRepo.list(this.orgId, { type: 'module' });
    const target = ENTITY_TEMPLATE_TARGETS[normalizedEntityType] || {
      module: ENTITY_MODULE_MAP[normalizedEntityType]
    };
    let selectedTemplate = findBestTemplateForTarget(allModuleTemplates, target);

    // Module-only fallback for expense/purchase. If the tenant's finance checklist
    // exists but lacks the exact 'Expenses' submodule (e.g. it was seeded via the
    // module-catalog bootstrap, which sets no submodule, or was renamed), the
    // strict submodule filter above returns null and the detail page shows "No
    // compliance checklist found" even though the checklist is visible in the
    // catalog. The submit path (ensureExpenseWorkflowChecklist) already applies
    // this fallback; mirror it here so both paths resolve to the same instance.
    if (!selectedTemplate && (normalizedEntityType === 'expense' || normalizedEntityType === 'purchase')) {
      selectedTemplate = findBestTemplateForTarget(allModuleTemplates, { module: 'Finances' })
        || findBestTemplateForTarget(allModuleTemplates, { module: 'Finance' });
    }

    let existing = await instanceRepo.findByContext(this.orgId, {
      type: 'module',
      entityType: normalizedEntityType,
      entityId: normalizedEntityId
    });
    // Backward compatibility: if an older alias context was used while creating,
    // recover by raw type before considering creation.
    const existingFromAlias =
      rawEntityType && rawEntityType !== normalizedEntityType
        ? await instanceRepo.findByContext(this.orgId, {
            type: 'module',
            entityType: rawEntityType,
            entityId: normalizedEntityId
          })
        : null;
    if (existingFromAlias) {
      if (
        String(existingFromAlias?.context?.entityType || '') !== normalizedEntityType ||
        String(existingFromAlias?.context?.entityId || '') !== normalizedEntityId
      ) {
        await instanceRepo.update(existingFromAlias._id, {
          context: {
            ...(existingFromAlias?.context || {}),
            entityType: normalizedEntityType,
            entityId: normalizedEntityId
          }
        });
      }
      if (approvalRequestId && !existingFromAlias.approval_request_id) {
        await instanceRepo.update(existingFromAlias._id, { approval_request_id: approvalRequestId });
      }
      return await instanceRepo.findById(existingFromAlias._id);
    }

    // If context lookup failed, bind by approvalRequestId to prevent instance splitting
    // between create/view/workflow pages for the same underlying approval.
    if (approvalRequestId) {
      const byApproval = await instanceRepo.findByApprovalRequest(this.orgId, approvalRequestId, { type: 'module' });
      if (byApproval) {
        // If we have multiple checklist instances for the same entity, ensure the
        // instance linked to this approval carries forward any checked state.
        if (existing && String(existing._id) !== String(byApproval._id)) {
          const doneCount = (inst) => (inst?.items || []).filter((i) => i?.checked || i?.state === 'satisfied').length;
          const existingDone = doneCount(existing);
          const byApprovalDone = doneCount(byApproval);

          if (existingDone > byApprovalDone) {
            const sourceByTitle = new Map(
              (existing?.items || []).map((i) => [String(i?.title_snapshot || '').trim().toLowerCase(), i])
            );

            let changed = false;
            byApproval.items = (byApproval.items || []).map((ti) => {
              const key = String(ti?.title_snapshot || '').trim().toLowerCase();
              const prev = sourceByTitle.get(key);
              if (!prev) return ti;

              const prevChecked = !!prev?.checked || prev?.state === 'satisfied';
              const prevHasEvidence = Array.isArray(prev?.evidence) && prev.evidence.length > 0;
              const prevHasNotes = typeof prev?.notes === 'string' && prev.notes.trim().length > 0;

              if (!prevChecked && !prevHasEvidence && !prevHasNotes) return ti;

              // Never wipe a "more complete" target item; only copy in checked/evidence/notes from the source.
              if (prevChecked) {
                if (ti.checked !== true) changed = true;
                if (ti.state !== 'satisfied') changed = true;
                return {
                  ...ti,
                  checked: true,
                  state: prev?.state || 'satisfied',
                  checked_by: prev?.checked_by || ti.checked_by || null,
                  checked_at: prev?.checked_at || ti.checked_at || null,
                  notes: prevHasNotes ? prev.notes : (ti.notes || ''),
                  evidence: prevHasEvidence ? prev.evidence : (ti.evidence || [])
                };
              }

              // If it wasn't checked, still carry evidence/notes (but don't change checked/state).
              if (prevHasEvidence || prevHasNotes) changed = true;
              return {
                ...ti,
                notes: prevHasNotes ? prev.notes : (ti.notes || ''),
                evidence: prevHasEvidence ? prev.evidence : (ti.evidence || [])
              };
            });

            if (changed) {
              await byApproval.save();
            }
          }
        }

        await instanceRepo.update(byApproval._id, {
          context: {
            ...(byApproval?.context || {}),
            entityType: normalizedEntityType,
            entityId: normalizedEntityId
          }
        });
        existing = byApproval;
      }
    }
    if (existing) {
      const existingTemplate = allModuleTemplates.find((t) => String(t?._id) === String(existing.template_id));
      const existingMatchesTarget = doesTemplateMatchTarget(existingTemplate, target);
      if (!existingMatchesTarget) {
        // For expense/purchase workflows, template metadata can drift over time.
        // In that case we must not hide the checklist if an instance already exists.
        if (!selectedTemplate) {
          if (normalizedEntityType === 'expense' || normalizedEntityType === 'purchase') {
            // Keep existing instance as-is (still attach approval_request_id below).
          } else {
            return null;
          }
        } else {
        const byTitle = new Map((existing.items || []).map((i) => [String(i.title_snapshot || '').trim().toLowerCase(), i]));
        existing.template_id = selectedTemplate._id;
        existing.items = (selectedTemplate.items || [])
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
        await existing.save();
        }
      }
      if (approvalRequestId && !existing.approval_request_id) {
        await instanceRepo.update(existing._id, { approval_request_id: approvalRequestId });
        return await instanceRepo.findById(existing._id);
      }
      return await instanceRepo.findById(existing._id);
    }
    if (!selectedTemplate) return null;

    const items = (selectedTemplate.items || [])
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((ti) => ({
        template_item_id: ti._id,
        title_snapshot: ti.title,
        description_snapshot: ti.description,
        category_snapshot: ti.category,
        type_snapshot: ti.type,
        auto_rule_key_snapshot: ti.autoRuleKey,
        required_evidence_snapshot: ti.requiredEvidence,
        state: 'pending',
        checked: false,
        notes: ''
      }));

    return await instanceRepo.create({
      org_id: this.orgId,
      template_id: selectedTemplate._id,
      type: 'module',
      context: { entityType: normalizedEntityType, entityId: normalizedEntityId },
      status: 'open',
      approval_request_id: approvalRequestId || null,
      items
    });
  }

  async listTemplates({ type, module } = {}) {
    await this.ensureV3Bootstrapped();
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistTemplateRepository(tenantDb);
    if (!module) return await repo.list(this.orgId, { type });

    // Always match on the NORMALIZED module name so singular/plural and
    // punctuation variants ('Finance' vs 'Finances', 'Complaint' vs
    // 'Complaints', 'Policies & Procedure' vs 'Policies & Procedures') all
    // resolve to the same module. The previous exact-match-first short-circuit
    // returned ONLY the exact variant when it matched anything: a 'Finances'
    // query that hit the lone plural-labelled donation-box template would never
    // surface the singular 'Finance' expense templates, so the expense page
    // showed a cash/donation-box checklist instead of the invoice one.
    const normalizedRequested = normalizeModuleName(module);
    const allForType = await repo.list(this.orgId, { type });
    return allForType.filter((t) => normalizeModuleName(t?.metadata?.module) === normalizedRequested);
  }

  async createTemplate(payload) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistTemplateRepository(tenantDb);
    return await repo.create({ ...payload, org_id: this.orgId });
  }

  async updateTemplate(templateId, payload) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistTemplateRepository(tenantDb);
    return await repo.update(templateId, payload);
  }

  async deleteTemplate(templateId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistTemplateRepository(tenantDb);
    return await repo.delete(templateId);
  }

  async createInstanceFromTemplate({ type, year, month, quarter }, createdBy) {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const instanceRepo = new ChecklistInstanceRepository(tenantDb);

    let template =
      await templateRepo.findActiveByType(this.orgId, type);
    if (!template && type === 'month_end') template = await this.ensureDefaultMonthEndTemplate();
    if (!template && type === 'quarter_end') template = await this.ensureDefaultQuarterEndTemplate();
    if (!template) throw new AppError('Checklist template not found', 404, 'TEMPLATE_NOT_FOUND');

    const period = { year: Number(year), month: month ? Number(month) : undefined, quarter: quarter ? Number(quarter) : undefined };
    const existing = await instanceRepo.findByPeriod(this.orgId, type, period);
    if (existing) return existing;

    const items = (template.items || [])
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((ti) => ({
        template_item_id: ti._id,
        title_snapshot: ti.title,
        description_snapshot: ti.description,
        category_snapshot: ti.category,
        type_snapshot: ti.type,
        auto_rule_key_snapshot: ti.autoRuleKey,
        required_evidence_snapshot: ti.requiredEvidence,
        due_date: computeDueDateForPeriod({ type, ...period }, ti.dueOffsetDays || 0),
        state: 'pending',
        checked: false,
        notes: ''
      }));

    const instance = await instanceRepo.create({
      org_id: this.orgId,
      template_id: template._id,
      type,
      period,
      status: 'open',
      items
    });

    try {
      await this._attachApprovalRequestToInstance(instance, createdBy);
    } catch (err) {
      logError('Failed to attach approval request for checklist instance', { error: err?.message, instanceId: instance._id });
    }

    return instance;
  }

  async ensureExpenseWorkflowChecklist({ expenseId, approvalRequestId, createdBy }) {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const instanceRepo = new ChecklistInstanceRepository(tenantDb);

    const existing = await instanceRepo.findByContext(this.orgId, {
      type: 'module',
      entityType: 'expense',
      entityId: expenseId
    });
    if (existing) {
      if (approvalRequestId && !existing.approval_request_id) {
        await instanceRepo.update(existing._id, { approval_request_id: approvalRequestId });
        return await instanceRepo.findById(existing._id);
      }
      return existing;
    }

    const moduleTemplates = await templateRepo.list(this.orgId, { type: 'module' });
    let template = findBestTemplateForTarget(moduleTemplates, ENTITY_TEMPLATE_TARGETS.expense);
    if (!template) {
      template = findBestTemplateForTarget(moduleTemplates, { module: 'Finances' })
        || findBestTemplateForTarget(moduleTemplates, { module: 'Finance' });
    }
    if (!template) return null;

    const items = (template.items || [])
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((ti) => ({
        template_item_id: ti._id,
        title_snapshot: ti.title,
        description_snapshot: ti.description,
        category_snapshot: ti.category,
        type_snapshot: ti.type,
        auto_rule_key_snapshot: ti.autoRuleKey,
        required_evidence_snapshot: ti.requiredEvidence,
        state: 'pending',
        checked: false,
        notes: ''
      }));

    const instance = await instanceRepo.create({
      org_id: this.orgId,
      template_id: template._id,
      type: 'module',
      context: {
        entityType: 'expense',
        entityId: String(expenseId)
      },
      status: 'open',
      approval_request_id: approvalRequestId || null,
      items
    });

    logInfo('Expense workflow checklist instance created', {
      orgId: this.orgId,
      expenseId: String(expenseId),
      checklistInstanceId: instance._id,
      approvalRequestId: approvalRequestId || null
    });
    return instance;
  }

  async _attachApprovalRequestToInstance(instance, createdBy) {
    const tenantDb = await this.getTenantDb();
    const instanceRepo = new ChecklistInstanceRepository(tenantDb);
    const approvalRepo = new ApprovalRequestRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);

    // Ensure Organization model exists and fetch org ObjectId (approval requests use ObjectId org_id)
    const organizationSchema = (await import('../db/schemas/platform/organizationSchema.js')).default;
    tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
    const org = await tenantDb.model('Organization').findOne().select('_id').lean();
    if (!org?._id) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');

    const orgOwner = await tenantDb.model('User').findOne({ is_org_owner: true }).select('_id first_name last_name email').lean();
    if (!orgOwner?._id) throw new AppError('No org owner user found to route finance close approval', 400, 'NO_APPROVER');

    const label = instance.type === 'month_end'
      ? `Month-end close — ${monthLabel(instance.period.year, instance.period.month)}`
      : `Quarter-end close — ${quarterLabel(instance.period.year, instance.period.quarter)}`;

    const approvalRequest = await approvalRepo.create({
      org_id: org._id,
      request_type: 'finance_period_close',
      entity_id: instance._id,
      entity_type: 'checklist_instance',
      amount: 0,
      approval_type: 'sequential',
      status: 'pending',
      approval_steps: [
        {
          level: 1,
          approver_user_id: orgOwner._id,
          status: 'pending'
        }
      ],
      submitted_by: createdBy || orgOwner._id
    });

    await instanceRepo.update(instance._id, { approval_request_id: approvalRequest._id });
    logInfo('Finance close approval request created', { orgId: this.orgId, instanceId: instance._id, approvalRequestId: approvalRequest._id });
    return approvalRequest;
  }

  async getInstance(instanceId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    let inst = await repo.findById(instanceId);
    if (!inst) throw new AppError('Checklist instance not found', 404, 'INSTANCE_NOT_FOUND');
    inst = await this._evaluateChecklistInstance(inst, tenantDb);
    return inst;
  }

  async listInstances(filters = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const list = await repo.list(this.orgId, filters);
    const out = [];
    for (const inst of list) {
      out.push(await this._evaluateChecklistInstance(inst, tenantDb));
    }
    return out;
  }

  async patchItem({ instanceId, itemId }, { checked, notes, addNote, addEvidence, state }, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const inst = await repo.findById(instanceId);
    if (!inst) throw new AppError('Checklist instance not found', 404, 'INSTANCE_NOT_FOUND');
    if (inst.status === 'closed') throw new AppError('Checklist is closed', 400, 'CHECKLIST_CLOSED');

    const item = (inst.items || []).find((it) => String(it._id) === String(itemId));
    if (!item) throw new AppError('Checklist item not found', 404, 'ITEM_NOT_FOUND');

    // Auto items resolve from platform data via the evaluation engine — they
    // must never be ticked (or un-ticked) by hand. Notes / evidence are still
    // allowed; only a checked/state change is rejected.
    if (item.type_snapshot === 'auto' && (typeof checked === 'boolean' || state)) {
      throw new AppError('Auto items resolve automatically and cannot be set manually', 400, 'AUTO_ITEM_NOT_MANUAL');
    }

    const updateEvidence = Array.isArray(addEvidence) ? addEvidence : (addEvidence ? [addEvidence] : []);
    if (updateEvidence.length > 0) {
      item.evidence = [...(item.evidence || []), ...updateEvidence.map((e) => ({
        file_key: e.file_key,
        file_name: e.file_name,
        mime_type: e.mime_type,
        size: e.size,
        uploaded_by: userId,
        uploaded_at: new Date()
      }))];
    }

    // Multi-note tracking — a note can arrive two ways, both APPEND (never
    // overwrite) so a second person can add their own note to the same item:
    //   1. `addNote: { text }` — the explicit multi-note payload.
    //   2. `notes: '<text>'` — the legacy single-note field, which the shared
    //      ChecklistEngine's note thread sends via the toggle handler on pages
    //      that don't wire `addNote` directly. Treated as an appended entry too.
    // Allowed on auto items (only checked/state are blocked above); blocked
    // entirely once closed (the CHECKLIST_CLOSED guard at the top).
    const notesToAppend = [];
    if (typeof notes === 'string' && notes.trim()) notesToAppend.push(notes.trim());
    if (addNote && typeof addNote === 'object' && String(addNote.text || '').trim()) {
      notesToAppend.push(String(addNote.text).trim());
    }
    if (notesToAppend.length) {
      item.note_entries = [
        ...(item.note_entries || []),
        ...notesToAppend.map((text) => ({ text, author: userId, created_at: new Date() }))
      ];
    }

    if (typeof checked === 'boolean') {
      // evidence enforcement for manual items
      if (checked && item.type_snapshot === 'manual' && item.required_evidence_snapshot === 'required') {
        if (!item.evidence || item.evidence.length === 0) {
          throw new AppError('Evidence is required to complete this item', 400, 'EVIDENCE_REQUIRED');
        }
      }
      // CHKL-004 — dependency blocking. Cannot mark satisfied until every
      // listed predecessor is itself satisfied/checked.
      if (checked && Array.isArray(item.depends_on_item_ids) && item.depends_on_item_ids.length > 0) {
        const byId = new Map((inst.items || []).map((it) => [String(it._id), it]));
        const blockers = item.depends_on_item_ids
          .map((id) => byId.get(String(id)))
          .filter((dep) => dep && !(dep.state === 'satisfied' || dep.checked));
        if (blockers.length > 0) {
          throw new AppError(
            `Complete the prerequisite item${blockers.length === 1 ? '' : 's'} first: ${blockers.map((b) => b.title_snapshot || 'item').join(', ')}`,
            400,
            'CHECKLIST_ITEM_BLOCKED'
          );
        }
      }
      item.checked = checked;
      item.checked_by = checked ? userId : null;
      item.checked_at = checked ? new Date() : null;
      item.state = checked ? 'satisfied' : 'pending';
    }

    if (state) {
      item.state = state;
      if (state === 'satisfied') {
        item.checked = true;
        item.checked_by = userId;
        item.checked_at = new Date();
      }
    }

    await inst.save();
    return await repo.findById(instanceId);
  }

  async closeInstance(instanceId, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const inst = await repo.findById(instanceId);
    if (!inst) throw new AppError('Checklist instance not found', 404, 'INSTANCE_NOT_FOUND');
    const total = (inst.items || []).length;
    const done = (inst.items || []).filter((i) => i.state === 'satisfied' || i.checked).length;
    if (total > 0 && done !== total) {
      throw new AppError('Cannot close period checklist until 100% complete', 400, 'CHECKLIST_INCOMPLETE');
    }
    return await repo.close(instanceId, userId);
  }

  async getOverdueSummary({ limit = 10 } = {}) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const open = await repo.list(this.orgId, { status: 'open' });
    const now = new Date();
    const overdueItems = [];

    for (const inst of open) {
      for (const it of inst.items || []) {
        const due = it.due_date ? new Date(it.due_date) : null;
        if (!due) continue;
        if ((it.state === 'satisfied' || it.checked) ) continue;
        if (due.getTime() < now.getTime()) {
          overdueItems.push({
            instance_id: inst._id,
            instance_type: inst.type,
            period: inst.period,
            item_id: it._id,
            title: it.title_snapshot,
            category: it.category_snapshot,
            due_date: it.due_date
          });
        }
      }
    }

    overdueItems.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
    return {
      count: overdueItems.length,
      items: overdueItems.slice(0, Number(limit) || 10)
    };
  }

  async getFinancePeriodSummary({ type, year, month, quarter }) {
    const tenantDb = await this.getTenantDb();
    const expenseRepo = new ExpenseRepository(tenantDb);

    const start = type === 'month_end'
      ? new Date(Date.UTC(Number(year), Number(month) - 1, 1, 0, 0, 0))
      : new Date(Date.UTC(Number(year), (Number(quarter) - 1) * 3, 1, 0, 0, 0));
    const end = type === 'month_end'
      ? new Date(Date.UTC(Number(year), Number(month), 1, 0, 0, 0))
      : new Date(Date.UTC(Number(year), (Number(quarter) - 1) * 3 + 3, 1, 0, 0, 0));

    const expenses = await expenseRepo.Expense.find({
      invoice_date: { $gte: start, $lt: end }
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('payment_processor_id', 'first_name last_name email')
      .populate('payment_reviewer_id', 'first_name last_name email')
      .populate('payment_co_signatory_id', 'first_name last_name email')
      .sort({ invoice_date: -1 })
      .lean();

    const mapped = (expenses || []).map((e) => ({
      _id: e._id,
      description: e.description,
      category: e.category,
      amount: e.amount,
      invoice_date: e.invoice_date,
      status: e.status,
      invoice_file: e.invoice_file,
      invoice_file_name: e.invoice_file_name,
      supplier_name: e.supplier_name || e.vendor_name,
      payment_stage: e.payment_stage,
      payment_approval_status: e.payment_approval_status,
      payment_initiated_by: e.payment_initiated_by,
      payment_processor_id: e.payment_processor_id,
      payment_co_signatory_id: e.payment_co_signatory_id,
      payment_reviewer_id: e.payment_reviewer_id,
      payment_dual_approval: e.payment_dual_approval,
      payments: (e.payments || []).map((p) => ({
        payment_method: p.payment_method,
        payment_date: p.payment_date,
        payment_proof: p.payment_proof,
        payment_proof_name: p.payment_proof_name
      }))
    }));

    return { start, end, count: mapped.length, expenses: mapped };
  }

  async _evaluateChecklistInstance(instanceDoc, tenantDb) {
    const inst = instanceDoc;
    // Period-based monthly compliance instances have no bound entity — they
    // evaluate their auto items against module data for the period instead.
    if (inst?.type === 'monthly_compliance') {
      return await this._evaluateMonthlyComplianceInstance(inst, tenantDb);
    }
    const entityType = String(inst?.context?.entityType || '').toLowerCase();
    const entityId = inst?.context?.entityId;
    if (!inst || !entityType || !entityId) return inst;

    const approvalRequestId = inst.approval_request_id?._id || inst.approval_request_id || null;
    let approval = null;
    if (approvalRequestId) {
      const approvalRepo = new ApprovalRequestRepository(tenantDb);
      approval = await approvalRepo.ApprovalRequest.findById(approvalRequestId).lean();
    }

    let expense = null;
    let risk = null;
    if (entityType === 'expense' || entityType === 'purchase') {
      const expenseRepo = new ExpenseRepository(tenantDb);
      expense = await expenseRepo.Expense.findById(entityId).lean();
      if (!expense) return inst;
    } else if (entityType === 'risk') {
      const riskRepo = new RiskRepository(tenantDb);
      risk = await riskRepo.findById(entityId);
      if (!risk) return inst;
    } else {
      return inst;
    }

    let changed = false;
    const now = new Date();
    const items = inst.items || [];
    const normalizeTitle = (t) => String(t || '').toLowerCase().trim();
    const normalizeRule = (r) => String(r || '').trim().toUpperCase();

    const applyAutoState = (item, satisfied, detail) => {
      // Only auto-evaluate items that are truly auto-driven.
      // If a user already explicitly checked the item, never override it on evaluation.
      if (item.type_snapshot !== 'auto') return;
      if (item.checked_by) {
        if (item.evaluation_detail !== detail) {
          item.evaluation_detail = detail;
          changed = true;
        }
        item.last_evaluated_at = now;
        return;
      }

      const nextState = satisfied ? 'satisfied' : 'pending';
      if (item.state !== nextState) {
        item.state = nextState;
        changed = true;
      }
      if (item.checked !== satisfied) {
        item.checked = satisfied;
        changed = true;
      }
      if (satisfied && !item.checked_at) {
        item.checked_at = now;
        changed = true;
      }
      if (!satisfied && item.checked_at) {
        item.checked_at = null;
        changed = true;
      }
      if (item.evaluation_detail !== detail) {
        item.evaluation_detail = detail;
        changed = true;
      }
      item.last_evaluated_at = now;
    };

    for (const item of items) {
      const title = normalizeTitle(item.title_snapshot);
      const ruleKey = normalizeRule(item?.auto_rule_key_snapshot);
      let matched = false;
      let satisfied = false;
      let detail = '';

      if (entityType === 'expense' || entityType === 'purchase') {
        if (ruleKey === 'EXPENSE.INVOICE_ATTACHED' || title.includes('invoice attached')) {
          matched = true;
          satisfied = !!expense.invoice_file;
          detail = satisfied ? 'Invoice file present on expense.' : 'Invoice file missing on expense.';
        } else if (ruleKey === 'EXPENSE.SUPPLIER_FIELDS_PRESENT' || title.includes('supplier details verified')) {
          matched = true;
          const hasName = !!(expense.supplier_name || expense.vendor_name);
          const hasInfo = !!expense.supplier_information;
          satisfied = hasName && hasInfo;
          detail = satisfied ? 'Supplier name and info present.' : 'Missing supplier name or supplier information.';
        } else if (ruleKey === 'EXPENSE.APPROVAL_ROUTING_PRESENT' || title.includes('approval routing correct')) {
          matched = true;
          const steps = approval?.approval_steps || [];
          satisfied = !!approval && steps.length > 0;
          detail = satisfied ? `Approval request linked with ${steps.length} step(s).` : 'Approval request/steps not found.';
        } else if (ruleKey === 'EXPENSE.PAYMENT_PROOF_PRESENT' || title.includes('payment proof captured')) {
          matched = true;
          const proofs = (expense.payments || []).filter((p) => !!p.payment_proof).length;
          satisfied = proofs > 0 || !!expense.payment_proof;
          detail = satisfied ? `Payment proof found (${proofs || 1} proof item).` : 'Payment proof not uploaded yet.';
        } else if (ruleKey === 'EXPENSE.DUAL_TRAIL_PRESENT' || title.includes('dual-signatory trail complete')) {
          matched = true;
          const hasProcessor = !!(expense.payment_processor_id || expense.assigned_to);
          const hasReviewer = !!expense.payment_reviewer_id;
          const hasCo = !!expense.payment_co_signatory_id;
          const coStatus = expense.payment_dual_approval?.co_signatory?.status;
          const signingStatus = expense.payment_dual_approval?.signing_reviewer?.status;
          satisfied = hasProcessor && hasReviewer && (hasCo || coStatus === 'waived' || signingStatus === 'approved');
          detail = satisfied
            ? 'Dual-signatory assignment/trail present.'
            : 'Missing processor/reviewer assignment or dual trail evidence.';
        }
      } else if (entityType === 'risk') {
        if (ruleKey === 'RISK.ATTACHMENT_PRESENT' || title.includes('attachment uploaded')) {
          matched = true;
          satisfied = (risk.attachments || []).length > 0;
          detail = satisfied ? 'Supporting attachment found on risk.' : 'No attachment uploaded yet.';
        } else if (ruleKey === 'RISK.OWNER_ASSIGNED' || title.includes('owner assigned')) {
          matched = true;
          satisfied = !!(risk.risk_owner_id || risk.risk_owner_board_member_id);
          detail = satisfied ? 'Risk owner/responsible person assigned.' : 'Risk owner not assigned.';
        } else if (ruleKey === 'RISK.NEXT_REVIEW_DATE_SET' || title.includes('review date set')) {
          matched = true;
          satisfied = !!risk.next_review_date;
          detail = satisfied ? 'Next review date is configured.' : 'Next review date is missing.';
        } else if (ruleKey === 'RISK.TREATMENT_CAPTURED' || title.includes('treatment workflow progressed')) {
          matched = true;
          satisfied = (risk.treatments || []).length > 0;
          detail = satisfied ? 'At least one treatment/control action captured.' : 'No treatment/control action captured yet.';
        }
      }

      if (!matched) continue;
      applyAutoState(item, satisfied, detail);
    }

    if (changed) {
      await inst.save();
      return await (new ChecklistInstanceRepository(tenantDb)).findById(inst._id);
    }
    return inst;
  }

  // ── Monthly Compliance Register ─────────────────────────────────────────

  /** Create (idempotently) the tenant's monthly_compliance template from the catalogue. */
  async ensureMonthlyComplianceTemplate() {
    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const existing = await templateRepo.findActiveByType(this.orgId, 'monthly_compliance');
    if (existing) return existing;

    let sortOrder = 10;
    const items = [];
    for (const moduleGroup of MONTHLY_COMPLIANCE_CATALOG) {
      for (const ci of moduleGroup.items) {
        const tail = [ci.code, ci.frequency].filter(Boolean).join(' · ');
        items.push({
          title: ci.title,
          description: tail ? `${ci.description} (${tail})` : ci.description,
          category: moduleGroup.module,
          type: ci.type === 'auto' ? 'auto' : 'manual',
          requiredEvidence: 'optional',
          assigneeRole: ci.responsible || 'Compliance Officer',
          autoRuleKey: ci.type === 'auto' ? ci.autoRuleKey : undefined,
          sortOrder
        });
        sortOrder += 10;
      }
    }

    const template = await templateRepo.create({
      org_id: this.orgId,
      name: 'Monthly Charity Compliance Checklist',
      type: 'monthly_compliance',
      description: 'Module-by-module monthly compliance register. Auto items resolve from platform data; manual items are ticked each month.',
      metadata: { source: 'monthly_compliance_catalog', version: 1, modules: MONTHLY_COMPLIANCE_CATALOG.map((m) => m.module) },
      items
    });
    logInfo('Created monthly compliance checklist template', { orgId: this.orgId, templateId: template._id, items: items.length });
    return template;
  }

  /** Create (idempotently) the monthly_compliance instance for a given year/month. */
  async createMonthlyComplianceInstance({ year, month }, _createdBy) {
    const tenantDb = await this.getTenantDb();
    const instanceRepo = new ChecklistInstanceRepository(tenantDb);
    const template = await this.ensureMonthlyComplianceTemplate();

    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw new AppError('Valid year and month (1-12) are required', 400, 'INVALID_PERIOD');
    }
    const period = { year: y, month: m };
    const existing = await instanceRepo.findByPeriod(this.orgId, 'monthly_compliance', period);
    if (existing) return await this._evaluateMonthlyComplianceInstance(existing, tenantDb);

    const items = (template.items || [])
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((ti) => ({
        template_item_id: ti._id,
        title_snapshot: ti.title,
        description_snapshot: ti.description,
        category_snapshot: ti.category,
        type_snapshot: ti.type,
        auto_rule_key_snapshot: ti.autoRuleKey,
        required_evidence_snapshot: ti.requiredEvidence,
        state: 'pending',
        checked: false,
        notes: ''
      }));

    const instance = await instanceRepo.create({
      org_id: this.orgId,
      template_id: template._id,
      type: 'monthly_compliance',
      period,
      status: 'open',
      items
    });
    logInfo('Created monthly compliance instance', { orgId: this.orgId, instanceId: instance._id, period });
    return await this._evaluateMonthlyComplianceInstance(instance, tenantDb);
  }

  /** List the whole register (every month), newest first, with per-module compliance summaries. */
  async listMonthlyComplianceRegister() {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const list = await repo.list(this.orgId, { type: 'monthly_compliance' });
    const out = [];
    for (const inst of list) {
      const evaluated = await this._evaluateMonthlyComplianceInstance(inst, tenantDb);
      out.push(this._summarizeMonthlyInstance(evaluated));
    }
    // Newest period first.
    out.sort((a, b) => (b.period.year - a.period.year) || (b.period.month - a.period.month));
    return out;
  }

  _summarizeMonthlyInstance(inst) {
    const obj = typeof inst?.toObject === 'function' ? inst.toObject() : inst;
    const items = obj.items || [];
    const isDone = (it) => it.state === 'satisfied' || it.checked;
    const byModule = new Map();
    for (const it of items) {
      const mod = it.category_snapshot || 'General';
      if (!byModule.has(mod)) byModule.set(mod, { module: mod, total: 0, satisfied: 0 });
      const row = byModule.get(mod);
      row.total += 1;
      if (isDone(it)) row.satisfied += 1;
    }
    const modules = [...byModule.values()].map((r) => ({ ...r, pct: r.total ? Math.round((r.satisfied / r.total) * 100) : 0 }));
    const satisfiedItems = items.filter(isDone).length;
    return {
      ...obj,
      summary: {
        totalItems: items.length,
        satisfiedItems,
        overallPct: items.length ? Math.round((satisfiedItems / items.length) * 100) : 0,
        modules
      }
    };
  }

  /** Add a custom item to a month's register — either a manual tick or a criteria-driven auto item. */
  async addMonthlyComplianceManualItem({ instanceId, title, description, module, mode, criteriaKey }, _userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const inst = await repo.findById(instanceId);
    if (!inst) throw new AppError('Checklist instance not found', 404, 'INSTANCE_NOT_FOUND');
    if (inst.type !== 'monthly_compliance') throw new AppError('Not a monthly compliance register', 400, 'WRONG_TYPE');
    if (inst.status === 'closed') throw new AppError('Register is closed', 400, 'CHECKLIST_CLOSED');

    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new AppError('Item title is required', 400, 'TITLE_REQUIRED');

    const isCriteria = String(mode || 'manual') === 'criteria';
    if (isCriteria) {
      const key = String(criteriaKey || '').trim().toUpperCase();
      if (!MONTHLY_COMPLIANCE_RULES[key]) throw new AppError('Unknown criteria', 400, 'UNKNOWN_CRITERIA');
    }

    inst.items.push({
      template_item_id: new mongoose.Types.ObjectId(),
      title_snapshot: cleanTitle,
      description_snapshot: String(description || '').trim(),
      category_snapshot: String(module || 'Custom').trim() || 'Custom',
      type_snapshot: isCriteria ? 'auto' : 'manual',
      auto_rule_key_snapshot: isCriteria ? String(criteriaKey).trim().toUpperCase() : undefined,
      required_evidence_snapshot: 'optional',
      state: 'pending',
      checked: false,
      notes: ''
    });
    await inst.save();
    const refreshed = await repo.findById(instanceId);
    return this._summarizeMonthlyInstance(await this._evaluateMonthlyComplianceInstance(refreshed, tenantDb));
  }

  /**
   * Month-end closure for a monthly compliance register. Locks the month as a
   * point-in-time record: once closed, `patchItem` and
   * `addMonthlyComplianceManualItem` reject all edits (CHECKLIST_CLOSED), so
   * ticks, notes and items can no longer change. Unlike the finance period
   * close, this does NOT require 100% completion — a month is signed off with
   * whatever was (and wasn't) achieved.
   */
  async closeMonthlyComplianceInstance(instanceId, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const inst = await repo.findById(instanceId);
    if (!inst) throw new AppError('Checklist instance not found', 404, 'INSTANCE_NOT_FOUND');
    if (inst.type !== 'monthly_compliance') throw new AppError('Not a monthly compliance register', 400, 'WRONG_TYPE');
    if (inst.status === 'closed') throw new AppError('Register is already closed', 400, 'ALREADY_CLOSED');
    await repo.close(instanceId, userId);
    const refreshed = await repo.findById(instanceId);
    logInfo('Closed monthly compliance register', { orgId: this.orgId, instanceId, period: inst.period });
    return this._summarizeMonthlyInstance(refreshed);
  }

  /** Evaluate the auto/criteria items on a monthly register for its period. */
  async _evaluateMonthlyComplianceInstance(instanceDoc, tenantDb) {
    const inst = instanceDoc;
    const year = inst?.period?.year;
    const month = inst?.period?.month;
    if (!year || !month) return inst;
    const win = monthWindow(year, month);
    const ctx = { tenantDb, win };
    const now = new Date();
    let changed = false;

    for (const item of inst.items || []) {
      if (item.type_snapshot !== 'auto') continue;
      const ruleKey = item.auto_rule_key_snapshot;
      if (!ruleKey || !MONTHLY_COMPLIANCE_RULES[String(ruleKey).trim().toUpperCase()]) continue;
      const result = await evaluateMonthlyRule(ruleKey, ctx);
      if (!result) continue;

      // Never override an item a user explicitly checked; just refresh its detail.
      if (item.checked_by) {
        if (item.evaluation_detail !== result.detail) { item.evaluation_detail = result.detail; changed = true; }
        item.last_evaluated_at = now;
        continue;
      }
      const nextState = result.satisfied ? 'satisfied' : 'pending';
      if (item.state !== nextState) { item.state = nextState; changed = true; }
      if (item.checked !== result.satisfied) { item.checked = result.satisfied; changed = true; }
      if (result.satisfied && !item.checked_at) { item.checked_at = now; changed = true; }
      if (!result.satisfied && item.checked_at) { item.checked_at = null; changed = true; }
      if (item.evaluation_detail !== result.detail) { item.evaluation_detail = result.detail; changed = true; }
      item.last_evaluated_at = now;
    }

    if (changed) {
      await inst.save();
      return await (new ChecklistInstanceRepository(tenantDb)).findById(inst._id);
    }
    return inst;
  }
}

