import { getTenantConnection } from '../db/connectionManager.js';
import { ChecklistTemplateRepository } from '../repositories/checklistTemplateRepository.js';
import { ChecklistInstanceRepository } from '../repositories/checklistInstanceRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo } from '../utils/logger.js';
import { COMPLIANCE_CHECKLIST_CATALOG } from '../config/complianceChecklistCatalog.js';

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
  policy: 'Compliance',
  risk: 'Compliance',
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

    const existing = await instanceRepo.findByContext(this.orgId, {
      type: 'module',
      entityType: normalizedEntityType,
      entityId: normalizedEntityId
    });
    if (existing) {
      if (approvalRequestId && !existing.approval_request_id) {
        await instanceRepo.update(existing._id, { approval_request_id: approvalRequestId });
        return await instanceRepo.findById(existing._id);
      }
      return existing;
    }

    const moduleName = ENTITY_MODULE_MAP[normalizedEntityType];
    if (!moduleName) return null;

    let moduleTemplates = await templateRepo.list(this.orgId, { type: 'module', module: moduleName });
    let selectedTemplate =
      moduleTemplates.find((t) => t?.metadata?.useCase !== 'expense_workflow') || moduleTemplates[0];
    if (!selectedTemplate) {
      await this.bootstrapComplianceCatalogTemplates();
      moduleTemplates = await templateRepo.list(this.orgId, { type: 'module', module: moduleName });
      selectedTemplate =
        moduleTemplates.find((t) => t?.metadata?.useCase !== 'expense_workflow') || moduleTemplates[0];
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
    return await repo.list(this.orgId, { type, module });
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
    if (!inst || !inst.context || inst.context.entityType !== 'expense' || !inst.context.entityId) {
      return inst;
    }

    const expenseRepo = new ExpenseRepository(tenantDb); // ensures Expense model registration
    const expense = await expenseRepo.Expense.findById(inst.context.entityId).lean();
    if (!expense) return inst;

    const approvalRequestId = inst.approval_request_id?._id || inst.approval_request_id || expense.approval_request_id;
    let approval = null;
    if (approvalRequestId) {
      const approvalRepo = new ApprovalRequestRepository(tenantDb); // ensures model registration
      approval = await approvalRepo.ApprovalRequest.findById(approvalRequestId).lean();
    }

    let changed = false;
    const now = new Date();
    const items = inst.items || [];

    const normalizeTitle = (t) => String(t || '').toLowerCase().trim();
    for (const item of items) {
      const title = normalizeTitle(item.title_snapshot);
      let auto = item.type_snapshot === 'auto';
      let satisfied = item.state === 'satisfied' || item.checked;
      let detail = '';

      if (title.includes('invoice attached')) {
        auto = true;
        satisfied = !!expense.invoice_file;
        detail = satisfied ? 'Invoice file present on expense.' : 'Invoice file missing on expense.';
      } else if (title.includes('supplier details verified')) {
        auto = true;
        const hasName = !!(expense.supplier_name || expense.vendor_name);
        const hasInfo = !!expense.supplier_information;
        satisfied = hasName && hasInfo;
        detail = satisfied ? 'Supplier name and info present.' : 'Missing supplier name or supplier information.';
      } else if (title.includes('approval routing correct')) {
        auto = true;
        const steps = approval?.approval_steps || [];
        satisfied = !!approval && steps.length > 0;
        detail = satisfied ? `Approval request linked with ${steps.length} step(s).` : 'Approval request/steps not found.';
      } else if (title.includes('payment proof captured')) {
        auto = true;
        const proofs = (expense.payments || []).filter((p) => !!p.payment_proof).length;
        satisfied = proofs > 0 || !!expense.payment_proof;
        detail = satisfied ? `Payment proof found (${proofs || 1} proof item).` : 'Payment proof not uploaded yet.';
      } else if (title.includes('dual-signatory trail complete')) {
        auto = true;
        const hasProcessor = !!(expense.payment_processor_id || expense.assigned_to);
        const hasReviewer = !!expense.payment_reviewer_id;
        const hasCo = !!expense.payment_co_signatory_id;
        const coStatus = expense.payment_dual_approval?.co_signatory?.status;
        const signingStatus = expense.payment_dual_approval?.signing_reviewer?.status;
        satisfied = hasProcessor && hasReviewer && (hasCo || coStatus === 'waived' || signingStatus === 'approved');
        detail = satisfied
          ? 'Dual-signatory assignment/trail present.'
          : 'Missing processor/reviewer assignment or dual trail evidence.';
      } else {
        continue;
      }

      if (item.type_snapshot !== (auto ? 'auto' : item.type_snapshot)) {
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
        item.checked_by = null; // auto checks are system-derived
        changed = true;
      }
      if (item.evaluation_detail !== detail) {
        item.evaluation_detail = detail;
        changed = true;
      }
      item.last_evaluated_at = now;
    }

    if (changed) {
      await inst.save();
      return await (new ChecklistInstanceRepository(tenantDb)).findById(inst._id);
    }
    return inst;
  }
}

