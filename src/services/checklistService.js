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
  expense: 'Finance',
  purchase: 'Finance',
  donation: 'Donations',
  donation_milestone: 'Donations',
  donor: 'Donor Care',
  grant: 'Operations',
  project: 'Operations',
  funding_agreement: 'Operations',
  partner: 'International',
  partner_vetting: 'International',
  policy: 'Policies & Procedures',
  risk: 'Compliance',
  registration_license: 'Governance',
  governing_document: 'Governance',
  licence_document: 'Governance',
  permit_document: 'Governance',
  approval_thresholds: 'Governance',
  yearly_statements: 'Governance',
  financial_controls: 'Finance',
  responsible_person: 'Governance',
  volunteer_person: 'Operations',
  hr_employee: 'Operations',
  hr_training: 'Operations',
  complaint: 'Operations',
  authority_transfer: 'IT',
  social_media_campaign: 'Marketing',
  social_media_campaigns: 'Marketing',
  emergency: 'IT'
};

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

  async ensureWorkflowChecklistForApproval({ entityType, entityId, approvalRequestId, createdBy }) {
    const normalizedEntityType = String(entityType || '').trim().toLowerCase();
    const normalizedEntityId = String(entityId || '').trim();
    if (!normalizedEntityType || !normalizedEntityId) {
      throw new AppError('entityType and entityId are required', 400, 'INVALID_WORKFLOW_CONTEXT');
    }

    if (normalizedEntityType === 'expense' || normalizedEntityType === 'purchase') {
      return await this.ensureExpenseWorkflowChecklist({
        expenseId: normalizedEntityId,
        approvalRequestId,
        createdBy
      });
    }

    const tenantDb = await this.getTenantDb();
    const templateRepo = new ChecklistTemplateRepository(tenantDb);
    const instanceRepo = new ChecklistInstanceRepository(tenantDb);

    // Risk checklist definitions are dictionary-driven and volatile.
    // Refresh template from dictionary on every resolve call.
    if (normalizedEntityType === 'risk') {
      await this.ensureDefaultRiskWorkflowTemplate();
    }
    if (
      normalizedEntityType === 'registration_license' ||
      normalizedEntityType === 'approval_thresholds' ||
      normalizedEntityType === 'yearly_statements' ||
      normalizedEntityType === 'financial_controls' ||
      normalizedEntityType === 'governing_document' ||
      normalizedEntityType === 'licence_document' ||
      normalizedEntityType === 'permit_document' ||
      normalizedEntityType === 'responsible_person' ||
      normalizedEntityType === 'volunteer_person' ||
      normalizedEntityType === 'hr_employee' ||
      normalizedEntityType === 'hr_training'
    ) {
      await this.syncSidebarDictionaryTemplates();
    }

    const existing = await instanceRepo.findByContext(this.orgId, {
      type: 'module',
      entityType: normalizedEntityType,
      entityId: normalizedEntityId
    });
    if (existing) {
      if (normalizedEntityType === 'risk') {
        let riskTemplate = (await templateRepo.list(this.orgId, { type: 'module', module: 'Compliance' }))
          .find((t) => t?.metadata?.useCase === 'risk_workflow');
        if (!riskTemplate) {
          riskTemplate = await this.ensureDefaultRiskWorkflowTemplate();
        }
        const templateItems = (riskTemplate?.items || [])
          .slice()
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        const existingTitleSet = new Set((existing.items || []).map((i) => String(i.title_snapshot || '').trim().toLowerCase()));
        const templateTitleSet = new Set(templateItems.map((i) => String(i.title || '').trim().toLowerCase()));
        const mismatch = String(existing.template_id) !== String(riskTemplate?._id)
          || existingTitleSet.size !== templateTitleSet.size
          || [...templateTitleSet].some((t) => !existingTitleSet.has(t));
        if (mismatch && existing.status !== 'closed') {
          const byTitle = new Map((existing.items || []).map((i) => [String(i.title_snapshot || '').trim().toLowerCase(), i]));
          existing.template_id = riskTemplate._id;
          existing.items = templateItems.map((ti) => {
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
      if (normalizedEntityType === 'approval_thresholds' && existing.status !== 'closed') {
        const governanceTemplates = await templateRepo.list(this.orgId, { type: 'module', module: 'Governance' });
        const thresholdTemplate = governanceTemplates.find((t) => {
          if (t?.metadata?.source !== 'sidebar_dictionary') return false;
          const moduleName = String(t?.metadata?.sidebarModule || '').trim().toLowerCase();
          const submoduleName = String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase();
          return moduleName === 'charity administration' && submoduleName.includes('approval threshold');
        });
        if (thresholdTemplate) {
          const templateItems = (thresholdTemplate.items || [])
            .slice()
            .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
          const existingTitleSet = new Set((existing.items || []).map((i) => String(i.title_snapshot || '').trim().toLowerCase()));
          const templateTitleSet = new Set(templateItems.map((i) => String(i.title || '').trim().toLowerCase()));
          const mismatch = String(existing.template_id) !== String(thresholdTemplate._id)
            || existingTitleSet.size !== templateTitleSet.size
            || [...templateTitleSet].some((t) => !existingTitleSet.has(t));
          if (mismatch) {
            const byTitle = new Map((existing.items || []).map((i) => [String(i.title_snapshot || '').trim().toLowerCase(), i]));
            existing.template_id = thresholdTemplate._id;
            existing.items = templateItems.map((ti) => {
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
      }
      if (approvalRequestId && !existing.approval_request_id) {
        await instanceRepo.update(existing._id, { approval_request_id: approvalRequestId });
        return await instanceRepo.findById(existing._id);
      }
      return await instanceRepo.findById(existing._id);
    }

    const moduleName = ENTITY_MODULE_MAP[normalizedEntityType];
    if (!moduleName) return null;

    let moduleTemplates = await templateRepo.list(this.orgId, { type: 'module', module: moduleName });
    if (normalizedEntityType === 'financial_controls' && (!moduleTemplates || moduleTemplates.length === 0)) {
      const alternates = await Promise.all([
        templateRepo.list(this.orgId, { type: 'module', module: 'Finance' }),
        templateRepo.list(this.orgId, { type: 'module', module: 'Finances' })
      ]);
      moduleTemplates = [...(alternates[0] || []), ...(alternates[1] || [])];
    }
    let selectedTemplate =
      normalizedEntityType === 'risk'
        ? moduleTemplates.find((t) => t?.metadata?.useCase === 'risk_workflow')
        : normalizedEntityType === 'registration_license'
          ? moduleTemplates.find((t) =>
            t?.metadata?.source === 'sidebar_dictionary' &&
            String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
            String(t?.metadata?.sidebarSubmodule || '') === 'Registrations & Licenses'
          )
          : normalizedEntityType === 'policy'
            ? moduleTemplates.find((t) =>
              t?.metadata?.source === 'sidebar_dictionary' &&
              (
                String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'policies & procedures' ||
                String(t?.metadata?.sidebarSection || '').trim().toLowerCase() === 'policies & procedures'
              )
            )
          : normalizedEntityType === 'governing_document'
            ? moduleTemplates.find((t) =>
              t?.metadata?.source === 'sidebar_dictionary' &&
              String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
              (
                String(t?.metadata?.sidebarSubmodule || '') === 'Governing Doc' ||
                String(t?.metadata?.sidebarSubmodule || '') === 'Governing Documents'
              )
            )
            : normalizedEntityType === 'licence_document' || normalizedEntityType === 'permit_document'
              ? moduleTemplates.find((t) =>
                t?.metadata?.source === 'sidebar_dictionary' &&
                String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
                String(t?.metadata?.sidebarSubmodule || '') === 'Registrations & Licenses'
              )
              : normalizedEntityType === 'approval_thresholds'
                ? moduleTemplates.find((t) =>
                  t?.metadata?.source === 'sidebar_dictionary' &&
                  String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'charity administration' &&
                  String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase().includes('approval threshold')
                )
                : normalizedEntityType === 'yearly_statements'
                  ? moduleTemplates.find((t) =>
                    t?.metadata?.source === 'sidebar_dictionary' &&
                    String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'charity administration' &&
                    String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase().includes('yearly statement')
                  )
                  : normalizedEntityType === 'financial_controls'
                    ? moduleTemplates.find((t) =>
                      t?.metadata?.source === 'sidebar_dictionary' &&
                      (
                        String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase() === 'financial controls' ||
                        String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'finances'
                      )
                    )
          : normalizedEntityType === 'responsible_person'
            ? moduleTemplates.find((t) =>
              t?.metadata?.source === 'sidebar_dictionary' &&
              String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
              String(t?.metadata?.sidebarSubmodule || '') === 'Responsible People'
            )
            : normalizedEntityType === 'volunteer_person'
              ? moduleTemplates.find((t) =>
                t?.metadata?.source === 'sidebar_dictionary' &&
                String(t?.metadata?.sidebarModule || '') === 'Volunteers'
              )
              : normalizedEntityType === 'hr_employee'
                ? moduleTemplates.find((t) =>
                  t?.metadata?.source === 'sidebar_dictionary' &&
                  String(t?.metadata?.sidebarModule || '') === 'People & HR' &&
                  String(t?.metadata?.sidebarSubmodule || '') === 'Employees'
                )
                : normalizedEntityType === 'hr_training'
                  ? moduleTemplates.find((t) =>
                    t?.metadata?.source === 'sidebar_dictionary' &&
                    String(t?.metadata?.sidebarModule || '') === 'People & HR' &&
                    (
                      String(t?.metadata?.sidebarSubmodule || '') === 'Trainings' ||
                      String(t?.metadata?.sidebarSubmodule || '') === 'Training Register'
                    )
                  )
          : moduleTemplates.find((t) => t?.metadata?.useCase !== 'expense_workflow');
    if (!selectedTemplate) {
      if (normalizedEntityType === 'risk') {
        await this.ensureDefaultRiskWorkflowTemplate();
      } else {
        await this.bootstrapComplianceCatalogTemplates();
      }
      moduleTemplates = await templateRepo.list(this.orgId, { type: 'module', module: moduleName });
      if (normalizedEntityType === 'financial_controls' && (!moduleTemplates || moduleTemplates.length === 0)) {
        const alternates = await Promise.all([
          templateRepo.list(this.orgId, { type: 'module', module: 'Finance' }),
          templateRepo.list(this.orgId, { type: 'module', module: 'Finances' })
        ]);
        moduleTemplates = [...(alternates[0] || []), ...(alternates[1] || [])];
      }
      selectedTemplate =
        normalizedEntityType === 'risk'
          ? moduleTemplates.find((t) => t?.metadata?.useCase === 'risk_workflow')
          : normalizedEntityType === 'registration_license'
            ? moduleTemplates.find((t) =>
              t?.metadata?.source === 'sidebar_dictionary' &&
              String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
              String(t?.metadata?.sidebarSubmodule || '') === 'Registrations & Licenses'
            )
            : normalizedEntityType === 'policy'
              ? moduleTemplates.find((t) =>
                t?.metadata?.source === 'sidebar_dictionary' &&
                (
                  String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'policies & procedures' ||
                  String(t?.metadata?.sidebarSection || '').trim().toLowerCase() === 'policies & procedures'
                )
              )
            : normalizedEntityType === 'governing_document'
              ? moduleTemplates.find((t) =>
                t?.metadata?.source === 'sidebar_dictionary' &&
                String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
                (
                  String(t?.metadata?.sidebarSubmodule || '') === 'Governing Doc' ||
                  String(t?.metadata?.sidebarSubmodule || '') === 'Governing Documents'
                )
              )
              : normalizedEntityType === 'licence_document' || normalizedEntityType === 'permit_document'
                ? moduleTemplates.find((t) =>
                  t?.metadata?.source === 'sidebar_dictionary' &&
                  String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
                  String(t?.metadata?.sidebarSubmodule || '') === 'Registrations & Licenses'
                )
                : normalizedEntityType === 'approval_thresholds'
                  ? moduleTemplates.find((t) =>
                    t?.metadata?.source === 'sidebar_dictionary' &&
                    String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'charity administration' &&
                    String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase().includes('approval threshold')
                  )
                  : normalizedEntityType === 'yearly_statements'
                    ? moduleTemplates.find((t) =>
                      t?.metadata?.source === 'sidebar_dictionary' &&
                      String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'charity administration' &&
                      String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase().includes('yearly statement')
                    )
                    : normalizedEntityType === 'financial_controls'
                      ? moduleTemplates.find((t) =>
                        t?.metadata?.source === 'sidebar_dictionary' &&
                        (
                          String(t?.metadata?.sidebarSubmodule || '').trim().toLowerCase() === 'financial controls' ||
                          String(t?.metadata?.sidebarModule || '').trim().toLowerCase() === 'finances'
                        )
                      )
            : normalizedEntityType === 'responsible_person'
              ? moduleTemplates.find((t) =>
                t?.metadata?.source === 'sidebar_dictionary' &&
                String(t?.metadata?.sidebarModule || '') === 'Charity Administration' &&
                String(t?.metadata?.sidebarSubmodule || '') === 'Responsible People'
              )
              : normalizedEntityType === 'volunteer_person'
                ? moduleTemplates.find((t) =>
                  t?.metadata?.source === 'sidebar_dictionary' &&
                  String(t?.metadata?.sidebarModule || '') === 'Volunteers'
                )
                : normalizedEntityType === 'hr_employee'
                  ? moduleTemplates.find((t) =>
                    t?.metadata?.source === 'sidebar_dictionary' &&
                    String(t?.metadata?.sidebarModule || '') === 'People & HR' &&
                    String(t?.metadata?.sidebarSubmodule || '') === 'Employees'
                  )
                  : normalizedEntityType === 'hr_training'
                    ? moduleTemplates.find((t) =>
                      t?.metadata?.source === 'sidebar_dictionary' &&
                      String(t?.metadata?.sidebarModule || '') === 'People & HR' &&
                      (
                        String(t?.metadata?.sidebarSubmodule || '') === 'Trainings' ||
                        String(t?.metadata?.sidebarSubmodule || '') === 'Training Register'
                      )
                    )
            : moduleTemplates.find((t) => t?.metadata?.useCase !== 'expense_workflow');
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
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistTemplateRepository(tenantDb);
    // Dictionary is source-of-truth for module checklists.
    if (!type || type === 'module') {
      await this.syncSidebarDictionaryTemplates();
    }
    // Keep risk workflow template in sync with checklist dictionary
    // so direct dictionary edits are reflected in UI/API reads.
    if (!module || module === 'Compliance') {
      await this.ensureDefaultRiskWorkflowTemplate();
    }
    const primary = await repo.list(this.orgId, { type, module });
    if (!module || primary.length > 0) return primary;

    // Fallback for minor module-name variants, e.g. "Policies & Procedure" vs "Policies & Procedures".
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

    let template = await templateRepo.findActiveByType(this.orgId, 'module');
    if (!template) template = await this.ensureDefaultExpenseWorkflowTemplate();

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

  async patchItem({ instanceId, itemId }, { checked, notes, addEvidence, state }, userId) {
    const tenantDb = await this.getTenantDb();
    const repo = new ChecklistInstanceRepository(tenantDb);
    const inst = await repo.findById(instanceId);
    if (!inst) throw new AppError('Checklist instance not found', 404, 'INSTANCE_NOT_FOUND');
    if (inst.status === 'closed') throw new AppError('Checklist is closed', 400, 'CHECKLIST_CLOSED');

    const item = (inst.items || []).find((it) => String(it._id) === String(itemId));
    if (!item) throw new AppError('Checklist item not found', 404, 'ITEM_NOT_FOUND');

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

    if (typeof notes === 'string') item.notes = notes;

    if (typeof checked === 'boolean') {
      // evidence enforcement for manual items
      if (checked && item.type_snapshot === 'manual' && item.required_evidence_snapshot === 'required') {
        if (!item.evidence || item.evidence.length === 0) {
          throw new AppError('Evidence is required to complete this item', 400, 'EVIDENCE_REQUIRED');
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
      if (item.type_snapshot !== 'auto') {
        item.type_snapshot = 'auto';
        changed = true;
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
      if (item.checked_by) {
        item.checked_by = null; // system-derived for auto checks
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
}

