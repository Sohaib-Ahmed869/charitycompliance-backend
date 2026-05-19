/**
 * Approval Detail PDF Generation Service
 * Generates professional PDF using Puppeteer (same pattern as policySignOffPdfService)
 */

import puppeteer from 'puppeteer';
import { resolveLogoSrcForPdf } from '../utils/pdfLogo.js';
import { generateApprovalFlowchart } from '../utils/approvalFlowchart.js';
import { getFileUrl } from './s3Service.js';

/* ── Helpers ────────────────────────────────────────── */

const formatDate = (date) => {
  if (!date) return '—';
  try {
    return new Date(date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
};

const formatTime = (date) => {
  if (!date) return '—';
  try {
    return new Date(date).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return '—'; }
};

const toTitleCase = (text) => {
  if (!text) return '—';
  return text.replace(/_/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
};

const formatCurrency = (amount) => {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount);
};

const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Entity-detail renderer (used by the ZIP exporter) ───────────────
// Per-entity-type curated field allowlist. Each entry chooses the
// human-meaningful fields (title, category, etc.) and ignores infra
// noise (file_path, mime_type, uploaded_by, approval_matrix_id, etc.).
// File-pointer fields are turned into clickable presigned-URL links
// so the auditor can open the source document straight from the PDF.

const ENTITY_INFRA_FIELDS = new Set([
  '_id', '__v', 'org_id', 'organization_id', 'tenant_id',
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
  'created_by', 'updated_by',
  'is_deleted', 'deleted_at', 'deleted_by',
  '_encrypted_fields'
]);

/**
 * Field configuration per entity_type. Each entry has:
 *   title:  section heading
 *   fields: ordered list of { key, label, format? } — format ∈
 *           date | titleCase | currency | boolean | none (default)
 *   file:   optional { keyField, nameField, label } — renders as a
 *           clickable link to a presigned S3 URL
 *
 * Only entity_types listed here render structured details. Anything
 * else falls back to a "Reference: <type>:<id>" line.
 */
const ENTITY_CONFIG = {
  policy: {
    title: 'Policy Details',
    fields: [
      { key: 'title',             label: 'Title' },
      { key: 'category',          label: 'Category' },
      { key: 'description',       label: 'Description' },
      { key: 'status',            label: 'Status', format: 'titleCase' },
      { key: 'version',           label: 'Version' },
      { key: 'effective_date',    label: 'Effective Date', format: 'date' },
      { key: 'review_cycle',      label: 'Review Cycle' },
      { key: 'next_review_date',  label: 'Next Review',    format: 'date' },
      { key: 'review_date',       label: 'Last Reviewed',  format: 'date' }
    ],
    file: { keyField: 'file_path', nameField: 'file_name', label: 'Policy Document' }
  },
  expense: {
    title: 'Expense Details',
    fields: [
      { key: 'expense_name',    label: 'Name' },
      { key: 'amount',          label: 'Amount',       format: 'currency' },
      { key: 'category',        label: 'Category' },
      { key: 'description',     label: 'Description' },
      { key: 'vendor_name',     label: 'Vendor' },
      { key: 'expense_date',    label: 'Expense Date', format: 'date' },
      { key: 'date',            label: 'Date',         format: 'date' },
      { key: 'status',          label: 'Status',       format: 'titleCase' },
      { key: 'payment_method',  label: 'Payment Method' }
    ]
  },
  risk: {
    title: 'Risk Details',
    fields: [
      { key: 'title',        label: 'Title' },
      { key: 'description',  label: 'Description' },
      { key: 'category',     label: 'Category' },
      { key: 'status',       label: 'Status', format: 'titleCase' },
      { key: 'likelihood',   label: 'Likelihood' },
      { key: 'severity',     label: 'Severity' },
      { key: 'risk_score',   label: 'Risk Score' },
      { key: 'owner',        label: 'Owner' },
      { key: 'review_date',  label: 'Next Review', format: 'date' }
    ]
  },
  donor: {
    title: 'Donor Details',
    fields: [
      { key: 'name',              label: 'Name' },
      { key: 'organization_name', label: 'Organisation' },
      { key: 'display_name',      label: 'Display Name' },
      { key: 'donor_type',        label: 'Donor Type',  format: 'titleCase' },
      { key: 'email',             label: 'Email' },
      { key: 'phone',             label: 'Phone' },
      { key: 'kyc_status',        label: 'KYC Status',  format: 'titleCase' },
      { key: 'vip_flag',          label: 'VIP Donor',   format: 'boolean' },
      { key: 'country',           label: 'Country' }
    ]
  },
  donation: {
    title: 'Donation Details',
    fields: [
      { key: 'title',          label: 'Title' },
      { key: 'campaign_name',  label: 'Campaign' },
      { key: 'amount',         label: 'Amount', format: 'currency' },
      { key: 'donation_date',  label: 'Date',   format: 'date' },
      { key: 'donor_name',     label: 'Donor' },
      { key: 'status',         label: 'Status', format: 'titleCase' },
      { key: 'description',    label: 'Description' }
    ]
  },
  donation_agreement: {
    title: 'Donation Agreement',
    fields: [
      { key: 'agreement_title', label: 'Title' },
      { key: 'donor_name',      label: 'Donor' },
      { key: 'amount',          label: 'Amount',     format: 'currency' },
      { key: 'start_date',      label: 'Start Date', format: 'date' },
      { key: 'end_date',        label: 'End Date',   format: 'date' },
      { key: 'status',          label: 'Status',     format: 'titleCase' }
    ],
    file: { keyField: 'document_path', nameField: 'document_name', label: 'Signed Agreement' }
  },
  donation_milestone: {
    title: 'Donation Milestone',
    fields: [
      { key: 'title',         label: 'Milestone' },
      { key: 'description',   label: 'Description' },
      { key: 'due_date',      label: 'Due Date',     format: 'date' },
      { key: 'completed_at',  label: 'Completed At', format: 'date' },
      { key: 'amount',        label: 'Amount',       format: 'currency' },
      { key: 'status',        label: 'Status',       format: 'titleCase' }
    ]
  },
  grant: {
    title: 'Grant Details',
    fields: [
      { key: 'title',        label: 'Title' },
      { key: 'grant_name',   label: 'Grant Name' },
      { key: 'amount',       label: 'Amount',     format: 'currency' },
      { key: 'donor',        label: 'Donor' },
      { key: 'start_date',   label: 'Start Date', format: 'date' },
      { key: 'end_date',     label: 'End Date',   format: 'date' },
      { key: 'status',       label: 'Status',     format: 'titleCase' },
      { key: 'description',  label: 'Description' }
    ]
  },
  funding_agreement: {
    title: 'Funding Agreement',
    fields: [
      { key: 'agreement_title', label: 'Title' },
      { key: 'partner_name',    label: 'Partner' },
      { key: 'amount',          label: 'Amount',     format: 'currency' },
      { key: 'start_date',      label: 'Start Date', format: 'date' },
      { key: 'end_date',        label: 'End Date',   format: 'date' },
      { key: 'status',          label: 'Status',     format: 'titleCase' }
    ]
  },
  project: {
    title: 'Project Details',
    fields: [
      { key: 'project_name', label: 'Project Name' },
      { key: 'description',  label: 'Description' },
      { key: 'start_date',   label: 'Start Date', format: 'date' },
      { key: 'end_date',     label: 'End Date',   format: 'date' },
      { key: 'status',       label: 'Status',     format: 'titleCase' },
      { key: 'budget',       label: 'Budget',     format: 'currency' }
    ]
  },
  partner_vetting: {
    title: 'Partner Vetting',
    fields: [
      { key: 'partner_name',        label: 'Partner' },
      { key: 'organization_name',   label: 'Organisation' },
      { key: 'country',             label: 'Country' },
      { key: 'kyc_status',          label: 'KYC Status',     format: 'titleCase' },
      { key: 'sanctions_status',    label: 'Sanctions Check', format: 'titleCase' },
      { key: 'status',              label: 'Status',         format: 'titleCase' }
    ]
  },
  complaint: {
    title: 'Complaint Details',
    fields: [
      { key: 'complaint_title', label: 'Title' },
      { key: 'subject',         label: 'Subject' },
      { key: 'description',     label: 'Description' },
      { key: 'category',        label: 'Category' },
      { key: 'severity',        label: 'Severity', format: 'titleCase' },
      { key: 'status',          label: 'Status',   format: 'titleCase' },
      { key: 'reported_by',     label: 'Reported By' },
      { key: 'reported_at',     label: 'Reported At', format: 'date' }
    ]
  },
  coi: {
    title: 'Conflict of Interest',
    fields: [
      { key: 'title',        label: 'Title' },
      { key: 'nature',       label: 'Nature of Conflict' },
      { key: 'subject',      label: 'Subject' },
      { key: 'description',  label: 'Description' },
      { key: 'declared_by',  label: 'Declared By' },
      { key: 'declared_at',  label: 'Declared At', format: 'date' },
      { key: 'status',       label: 'Status',      format: 'titleCase' }
    ]
  },
  contract: {
    title: 'Contract Details',
    fields: [
      { key: 'contract_title', label: 'Title' },
      { key: 'counterparty',   label: 'Counterparty' },
      { key: 'value',          label: 'Value',      format: 'currency' },
      { key: 'start_date',     label: 'Start Date', format: 'date' },
      { key: 'end_date',       label: 'End Date',   format: 'date' },
      { key: 'status',         label: 'Status',     format: 'titleCase' }
    ],
    file: { keyField: 'document_path', nameField: 'document_name', label: 'Contract Document' }
  },
  purchase: {
    title: 'Purchase Request',
    fields: [
      { key: 'item_description', label: 'Item' },
      { key: 'description',      label: 'Description' },
      { key: 'amount',           label: 'Amount',  format: 'currency' },
      { key: 'vendor',           label: 'Vendor' },
      { key: 'status',           label: 'Status',  format: 'titleCase' }
    ]
  },
  social_media_campaign: {
    title: 'Campaign Details',
    fields: [
      { key: 'campaign_name', label: 'Campaign' },
      { key: 'platform',      label: 'Platform' },
      { key: 'description',   label: 'Description' },
      { key: 'start_date',    label: 'Start Date', format: 'date' },
      { key: 'end_date',      label: 'End Date',   format: 'date' },
      { key: 'budget',        label: 'Budget',     format: 'currency' },
      { key: 'status',        label: 'Status',     format: 'titleCase' }
    ]
  },
  sweep_funds: {
    title: 'Sweep Funds Request',
    fields: [
      { key: 'title',                       label: 'Title' },
      { key: 'reference',                   label: 'Reference' },
      { key: 'amount',                      label: 'Amount', format: 'currency' },
      { key: 'source_portal',               label: 'From' },
      { key: 'destination_account_label',   label: 'To' },
      { key: 'status',                      label: 'Status', format: 'titleCase' }
    ]
  },
  donor_refund: {
    title: 'Donor Refund',
    fields: [
      { key: 'donor_name',  label: 'Donor' },
      { key: 'amount',      label: 'Amount', format: 'currency' },
      { key: 'reason',      label: 'Reason' },
      { key: 'status',      label: 'Status', format: 'titleCase' },
      { key: 'created_at',  label: 'Initiated At', format: 'date' }
    ]
  },
  meeting: {
    title: 'Meeting Details',
    fields: [
      { key: 'title',         label: 'Title' },
      { key: 'meeting_date',  label: 'Date',     format: 'date' },
      { key: 'location',      label: 'Location' },
      { key: 'agenda',        label: 'Agenda' },
      { key: 'status',        label: 'Status',   format: 'titleCase' }
    ]
  },
  training: {
    title: 'Training Programme',
    fields: [
      { key: 'title',        label: 'Title' },
      { key: 'category',     label: 'Category' },
      { key: 'description',  label: 'Description' },
      { key: 'duration',     label: 'Duration' },
      { key: 'status',       label: 'Status', format: 'titleCase' }
    ]
  }
};

/** Format a single value according to its declared format type. */
function formatFieldCell(value, format) {
  if (value === null || value === undefined || value === '') return '';
  if (format === 'date')      { try { return esc(formatDate(value)); } catch { return esc(String(value)); } }
  if (format === 'currency')  return esc(formatCurrency(Number(value) || 0));
  if (format === 'boolean')   return value ? 'Yes' : 'No';
  if (format === 'titleCase') return esc(toTitleCase(value));
  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (value.every((v) => typeof v !== 'object')) return value.map((v) => esc(String(v))).join(', ');
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId' || value.toHexString) return esc(value.toString());
    return esc(JSON.stringify(value));
  }
  return esc(String(value));
}

/**
 * Render the entity-details section. Async because file fields are
 * resolved into presigned S3 URLs so the auditor can click straight
 * through to the source document from the PDF.
 *
 * Falls back to a single-line reference for entity_types not in the
 * config map (rare — covers the long tail of obscure workflow kinds).
 */
async function renderEntityHTML(entity, entityType, requestType) {
  if (!entity || typeof entity !== 'object') return '';
  const lookupKey = String(entityType || requestType || '').toLowerCase();
  const config = ENTITY_CONFIG[lookupKey];
  if (!config) {
    // Unknown type — show just the title or reference so the auditor
    // at least sees "this approval was for X".
    const fallbackTitle = entity.title || entity.name || entity.display_name || entity.subject;
    if (!fallbackTitle) return '';
    return `
      <h2>Entity Details</h2>
      <table class="info-table">
        <tr><td>Reference</td><td>${esc(fallbackTitle)}</td></tr>
      </table>
    `;
  }

  // Curated field rows — skip anything empty or missing.
  const rows = [];
  for (const field of config.fields) {
    const raw = entity[field.key];
    if (raw === null || raw === undefined || raw === '') continue;
    const cell = formatFieldCell(raw, field.format);
    if (!cell) continue;
    rows.push(`<tr><td>${esc(field.label)}</td><td>${cell}</td></tr>`);
  }

  // File-link row — resolves to a 7-day presigned URL so the auditor
  // can open the source file directly. Failures to mint a URL fall
  // back to the filename in plain text.
  if (config.file) {
    const key  = entity[config.file.keyField];
    const name = entity[config.file.nameField] || (typeof key === 'string' ? key.split('/').pop() : '');
    if (key && typeof key === 'string') {
      let href = '';
      try {
        href = await getFileUrl(key, 7 * 24 * 60 * 60);
      } catch (err) {
        // Bad/missing S3 key — render the filename without a link.
      }
      const cell = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${esc(name || 'Open document')}</a>`
        : esc(name || 'Document attached');
      rows.push(`<tr><td>${esc(config.file.label)}</td><td>${cell}</td></tr>`);
    }
  }

  if (!rows.length) return '';
  return `
    <h2>${esc(config.title)}</h2>
    <table class="info-table">
      ${rows.join('\n      ')}
    </table>
  `;
}

const REQUEST_TYPE_LABELS = {
  expense: 'Expense Reimbursement',
  risk: 'Risk Assessment',
  risk_treatment: 'Risk Treatment',
  coi: 'Conflict of Interest',
  purchase: 'Purchase',
  grant: 'Grant',
  funding_agreement: 'Funding Agreement',
  partner_vetting: 'Partner Vetting',
  policy: 'Policy',
  policy_approval: 'Policy Approval',
  document_approval: 'Document Approval',
  financial_reporting: 'Financial Reporting',
  bas_lodgement: 'BAS lodgement',
  hr: 'HR',
  other: 'Approval Request',
};

const GOVERNANCE_LABELS = {
  expense: 'Financial Controls',
  risk: 'Governance & Risk',
  risk_treatment: 'Governance & Risk',
  coi: 'Governance & Risk',
  funding_agreement: 'Grants & Funders',
  partner_vetting: 'Grants & Funders',
  grant: 'Grants & Funders',
  policy: 'Policies & Procedures',
  financial_reporting: 'Financial Controls',
  bas_lodgement: 'Financial Controls',
  hr: 'Human Resources',
  other: 'Compliance',
};

/**
 * Refresh all S3 file URLs in approval request to ensure they are not expired
 * Presigned URLs expire after 7 days, so we regenerate them at PDF export time
 */
async function refreshApprovalFileUrls(approvalRequest, checklistInstance = null) {
  try {
    // Process approval steps
    if (Array.isArray(approvalRequest.approval_steps)) {
      for (const step of approvalRequest.approval_steps) {
        // Refresh acknowledgement files
        if (Array.isArray(step.acknowledgement_files)) {
          for (const file of step.acknowledgement_files) {
            if (file.key) {
              file.url = await getFileUrl(file.key, 604800); // 7 days
            }
          }
        }
        // Refresh rejection review files
        if (Array.isArray(step.rejection_reviews)) {
          for (const review of step.rejection_reviews) {
            if (Array.isArray(review.rejection_files)) {
              for (const file of review.rejection_files) {
                if (file.key) {
                  file.url = await getFileUrl(file.key, 604800);
                }
              }
            }
          }
        }
      }
    }

    // Refresh escalation files
    if (Array.isArray(approvalRequest.escalations)) {
      for (const esc of approvalRequest.escalations) {
        if (Array.isArray(esc.escalation_files)) {
          for (const file of esc.escalation_files) {
            if (file.key) {
              file.url = await getFileUrl(file.key, 604800);
            }
          }
        }
      }
    }

    // Refresh request-level rejection review files
    if (Array.isArray(approvalRequest.rejection_reviews)) {
      for (const rr of approvalRequest.rejection_reviews) {
        if (Array.isArray(rr.rejection_files)) {
          for (const file of rr.rejection_files) {
            if (file.key) {
              file.url = await getFileUrl(file.key, 604800);
            }
          }
        }
      }
    }

    if (checklistInstance?.items?.length) {
      for (const item of checklistInstance.items) {
        if (!Array.isArray(item?.evidence)) continue;
        for (const ev of item.evidence) {
          if (ev?.file_key) {
            ev.file_url = await getFileUrl(ev.file_key, 604800);
          }
        }
      }
    }
    return { approvalRequest, checklistInstance };
  } catch (error) {
    // Log error but don't fail PDF generation if URL refresh fails
    console.error('Warning: Could not refresh some S3 URLs for PDF:', error.message);
    return { approvalRequest, checklistInstance };
  }
}

/**
 * @param {Object} approvalRequest – Full approval request (populated)
 * @param {Object} expense         – Expense entity (or null)
 * @param {Object} risk            – Risk entity (or null)
 * @param {string} logoUrl
 * @param {Object|null} checklistInstance
 */
export const generateApprovalPDF = async (approvalRequest, expense, risk, logoUrl, checklistInstance = null, options = {}) => {
  // Refresh all S3 file URLs to ensure they are not expired
  ({ approvalRequest, checklistInstance } = await refreshApprovalFileUrls(approvalRequest, checklistInstance));

  const logoSrc = await resolveLogoSrcForPdf(logoUrl);

  // Batch caller (e.g. ZIP export) can pass an already-launched browser
  // to skip the 1-2s puppeteer warmup per PDF. When that happens we
  // borrow the browser, generate the PDF, close the page and leave the
  // browser open for the next call. Otherwise we own the browser end
  // to end, same as the original single-PDF behaviour.
  const providedBrowser = options.browser;
  const ownsBrowser = !providedBrowser;
  const browser = providedBrowser || await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let page = null;

  try {
    page = await browser.newPage();

    const steps = approvalRequest.approval_steps || [];
    const previousAttempts = approvalRequest.previous_attempts || [];
    const title = REQUEST_TYPE_LABELS[approvalRequest.request_type] || toTitleCase(approvalRequest.request_type) || 'Approval Request';
    const category = GOVERNANCE_LABELS[approvalRequest.request_type] || 'Compliance';
    const submittedBy = approvalRequest.submitted_by
      ? `${approvalRequest.submitted_by.first_name || ''} ${approvalRequest.submitted_by.last_name || ''}`.trim() || '—'
      : '—';
    const statusLabel = toTitleCase(approvalRequest.status);
    const approvalType = approvalRequest.approval_type === 'sequential'
      ? 'Sequential (one-by-one)'
      : approvalRequest.approval_type === 'parallel'
      ? 'Parallel (all at once)'
      : toTitleCase(approvalRequest.approval_type);

    const approvedSteps = steps.filter(s => s.status === 'approved').length;
    const rejectedSteps = steps.filter(s => s.status === 'rejected').length;
    const pendingSteps = steps.filter(s => s.status === 'pending').length;

    // ── Entity Details ──
    // For the ZIP exporter we pass the raw entity document as
    // `options.entity` along with its entity_type. The generic
    // renderer below covers every workflow type — policy, donor,
    // risk, grant, complaint, etc. — by listing the entity's
    // human-meaningful fields. The legacy expense/risk paths still
    // win when those are explicitly passed (in-app single-PDF flow).
    let entityHTML = '';
    if (expense) {
      entityHTML = `
        <h2>Expense Details</h2>
        <table class="info-table">
          <tr><td>Amount</td><td>${formatCurrency(expense.amount)}</td></tr>
          <tr><td>Category</td><td>${esc(expense.category || '—')}</td></tr>
          <tr><td>Description</td><td>${esc(expense.description || '—')}</td></tr>
          ${expense.vendor_name ? `<tr><td>Vendor</td><td>${esc(expense.vendor_name)}</td></tr>` : ''}
          ${expense.date ? `<tr><td>Expense Date</td><td>${formatDate(expense.date)}</td></tr>` : ''}
        </table>
      `;
    } else if (risk) {
      const isTreatment = approvalRequest.request_type === 'risk_treatment';
      const treatment = isTreatment ? risk.treatments?.[approvalRequest.treatment_index] : null;

      if (isTreatment && treatment) {
        entityHTML = `
          <h2>Treatment Details</h2>
          <table class="info-table">
            <tr><td>Risk Title</td><td>${esc(risk.title || '—')}</td></tr>
            <tr><td>Treatment Owner</td><td>${esc(treatment.owner || '—')}</td></tr>
            <tr><td>Control Action</td><td>${esc(treatment.control_action || '—')}</td></tr>
            <tr><td>Due Date</td><td>${formatDate(treatment.due_date)}</td></tr>
            <tr><td>Status</td><td>${toTitleCase(treatment.status)}</td></tr>
          </table>
        `;
      } else {
        entityHTML = `
          <h2>Risk Details</h2>
          <table class="info-table">
            <tr><td>Risk Title</td><td>${esc(risk.title || '—')}</td></tr>
            <tr><td>Status</td><td>${toTitleCase(risk.status)}</td></tr>
            <tr><td>Description</td><td>${esc(risk.description || '—')}</td></tr>
            ${risk.likelihood ? `<tr><td>Likelihood</td><td>${risk.likelihood}</td></tr>` : ''}
            ${risk.severity ? `<tr><td>Severity</td><td>${risk.severity}</td></tr>` : ''}
            ${risk.risk_score ? `<tr><td>Risk Score</td><td>${risk.risk_score}</td></tr>` : ''}
          </table>
        `;
      }
    } else if (options.entity) {
      // Curated entity renderer — used by the ZIP exporter for every
      // workflow type that doesn't have a dedicated section above.
      // Per-type allowlist of fields with proper formatting, plus a
      // clickable presigned-URL link for the entity's main document.
      entityHTML = await renderEntityHTML(options.entity, options.entityType, approvalRequest.request_type);
    }

    // ── Steps table ──
    let stepRows = '';
    steps.forEach((step, idx) => {
      let statusClass = 'status-pending';
      if (step.status === 'approved') statusClass = 'status-approved';
      if (step.status === 'rejected') statusClass = 'status-rejected';

      const isDeptHead = step.is_department_head === true;
      const posTitle = isDeptHead
        ? 'Head of Department'
        : (step.approver_position_id?.title || step.approver_department_id?.name || `Step ${steps.slice(0, idx).filter(s => !s.is_department_head).length + 1}`);
      const approverName = step.approver_user_id
        ? `${step.approver_user_id.first_name || ''} ${step.approver_user_id.last_name || ''}`.trim() || '—'
        : '—';
      const reviewDate = step.approved_at || step.rejected_at;

      let notes = '';
      if (step.comments) {
        notes += `<div style="margin-top:3px;font-size:9px;color:#4A5568;">Comments: ${esc(step.comments)}</div>`;
      }
      if (step.acknowledgement_note) {
        notes += `<div style="margin-top:3px;font-size:9px;color:#3B82F6;">Acknowledgement: ${esc(step.acknowledgement_note)}</div>`;
      }
      if (step.acknowledgement_files?.length) {
        const filesHTML = step.acknowledgement_files
          .map((f) => {
            const name = esc(f.name || 'file');
            const url = f.url;
            return url
              ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${name}</a>`
              : name;
          })
          .join(', ');
        notes += `<div style="margin-top:3px;font-size:9px;color:#6366F1;">Attachments: ${step.acknowledgement_files.length} file${step.acknowledgement_files.length !== 1 ? 's' : ''}: ${filesHTML}</div>`;
      }

      stepRows += `<tr>
        <td style="vertical-align:top;">${esc(posTitle)}</td>
        <td style="vertical-align:top;">${esc(approverName)}</td>
        <td style="vertical-align:top;"><span class="status-badge ${statusClass}">${toTitleCase(step.status || 'pending')}</span></td>
        <td style="vertical-align:top;font-size:9px;">${reviewDate ? `${formatDate(reviewDate)}<br/>${formatTime(reviewDate)}` : '—'}</td>
        <td style="vertical-align:top;font-size:9px;">${esc(step.comments || '—')}${notes}</td>
      </tr>`;
    });

    // ── Acknowledgements summary ──
    const stepsWithAck = steps.filter(s => s.acknowledgement_files?.length || s.acknowledgement_note);
    let ackHTML = '';
    if (stepsWithAck.length > 0) {
      let ackRows = '';
      stepsWithAck.forEach(step => {
        const approverName = step.approver_user_id
          ? `${step.approver_user_id.first_name || ''} ${step.approver_user_id.last_name || ''}`.trim() || '—'
          : '—';
        const posTitle = step.approver_position_id?.title || '—';

        let filesHTML = '—';
        if (step.acknowledgement_files?.length) {
          filesHTML = step.acknowledgement_files.map(f => {
            const name = esc(f.name || 'file');
            const url = f.url;
            return url
              ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${name}</a>`
              : name;
          }).join(', ');
        }

        ackRows += `<tr>
          <td>${esc(approverName)}</td>
          <td>${esc(posTitle)}</td>
          <td style="font-size:9px;">${esc(step.acknowledgement_note || '—')}</td>
          <td style="font-size:9px;">${filesHTML}</td>
        </tr>`;
      });

      ackHTML = `
        <h2>Acknowledgements</h2>
        <table>
          <thead><tr><th>Approver</th><th>Position</th><th>Note</th><th>Files</th></tr></thead>
          <tbody>${ackRows}</tbody>
        </table>
      `;
    }

    // ── Workflow checklist log ──
    let checklistHTML = '';
    if (checklistInstance?.items?.length) {
      const checklistRows = checklistInstance.items.map((item, idx) => {
        const checkedBy = item?.checked_by
          ? `${item.checked_by.first_name || ''} ${item.checked_by.last_name || ''}`.trim() || item.checked_by.email || '—'
          : '—';
        const checkedAt = item?.checked_at
          ? `${formatDate(item.checked_at)} ${formatTime(item.checked_at)}`
          : '—';
        const stateLabel = toTitleCase(item?.state || (item?.checked ? 'satisfied' : 'pending'));
        const evidenceList = Array.isArray(item?.evidence) ? item.evidence : [];
        const evidenceHTML = evidenceList.length
          ? evidenceList.map((ev) => {
            const uploader = ev?.uploaded_by
              ? `${ev.uploaded_by.first_name || ''} ${ev.uploaded_by.last_name || ''}`.trim() || ev.uploaded_by.email || '—'
              : '—';
            const at = ev?.uploaded_at ? `${formatDate(ev.uploaded_at)} ${formatTime(ev.uploaded_at)}` : '—';
            const fileName = esc(ev?.file_name || 'attachment');
            const link = ev?.file_url
              ? `<a href="${esc(ev.file_url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${fileName}</a>`
              : fileName;
            return `<div style="margin-top:2px;">• ${link} <span style="color:#64748B;">(by ${esc(uploader)} at ${esc(at)})</span></div>`;
          }).join('')
          : '—';

        return `<tr>
          <td style="vertical-align:top;">${idx + 1}</td>
          <td style="vertical-align:top;">${esc(item?.title_snapshot || 'Checklist item')}</td>
          <td style="vertical-align:top;"><span class="status-badge ${item?.checked ? 'status-approved' : 'status-pending'}">${esc(stateLabel)}</span></td>
          <td style="vertical-align:top;font-size:9px;">${esc(checkedBy)}</td>
          <td style="vertical-align:top;font-size:9px;">${esc(checkedAt)}</td>
          <td style="vertical-align:top;font-size:9px;">${esc(item?.notes || '—')}</td>
          <td style="vertical-align:top;font-size:9px;">${evidenceHTML}</td>
        </tr>`;
      }).join('');

      checklistHTML = `
        <h2>Checklist Audit Log</h2>
        <table>
          <thead><tr>
            <th style="width:36px;">#</th>
            <th>Checklist Item</th>
            <th>Status</th>
            <th>Completed By</th>
            <th>Completed At</th>
            <th>Notes</th>
            <th>Evidence / Attachments</th>
          </tr></thead>
          <tbody>${checklistRows}</tbody>
        </table>
      `;
    }

    // ── Final approval e‑signature (if captured) ──
    let finalSignatureHTML = '';
    const finalApprovedStep = steps.slice().reverse().find(s => s.status === 'approved' && s.signature_data);
    if (finalApprovedStep && typeof finalApprovedStep.signature_data === 'string' && finalApprovedStep.signature_data.startsWith('data:')) {
      const approverName = finalApprovedStep.approver_user_id
        ? `${finalApprovedStep.approver_user_id.first_name || ''} ${finalApprovedStep.approver_user_id.last_name || ''}`.trim() || '—'
        : '—';
      finalSignatureHTML = `
        <h2>Final Approval Signature</h2>
        <table class="info-table">
          <tr>
            <td>Approved By</td>
            <td>${esc(approverName)}</td>
          </tr>
          <tr>
            <td>Signature</td>
            <td>
              <img src="${finalApprovedStep.signature_data}" alt="Final approval signature" class="signature-img" />
            </td>
          </tr>
        </table>
      `;
    }
    
    // ── Submitter notes ──
    // Reason / context the submitter wrote at request time. The
    // controller writes this for policy + donor_refund flows; for
    // other types it may be empty.
    let submitterNotesHTML = '';
    const submitterNotes = approvalRequest.submitter_notes;
    if (submitterNotes && String(submitterNotes).trim()) {
      submitterNotesHTML = `
        <h2>Submitter Notes</h2>
        <table class="info-table">
          <tr>
            <td>From ${esc(submittedBy)}</td>
            <td style="white-space:pre-wrap;">${esc(submitterNotes)}</td>
          </tr>
        </table>
      `;
    }

    // ── Rejection reviews ──
    // When an approver rejects mid-flow, they can forward the
    // rejection to someone (typically a senior) for a second
    // opinion. The full back-and-forth lives in rejection_reviews[]
    // and is part of the audit trail — render it as its own table.
    let rejectionReviewsHTML = '';
    const rrList = Array.isArray(approvalRequest.rejection_reviews) ? approvalRequest.rejection_reviews : [];
    if (rrList.length) {
      const rrRows = rrList.map((rr, i) => {
        const rejectedByName = rr.rejected_by
          ? `${rr.rejected_by.first_name || ''} ${rr.rejected_by.last_name || ''}`.trim() || rr.rejected_by.email || '—'
          : '—';
        const forwardedToName = rr.forwarded_to
          ? `${rr.forwarded_to.first_name || ''} ${rr.forwarded_to.last_name || ''}`.trim() || rr.forwarded_to.email || '—'
          : '—';
        const filesHTML = (rr.rejection_files || []).map((f) => {
          const name = esc(f.name || 'file');
          return f.url
            ? `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${name}</a>`
            : name;
        }).join(', ') || '—';
        const reviewLabel = rr.review_action === 'accept_rejection'
          ? 'Rejection upheld'
          : rr.review_action === 'reject_rejection'
            ? 'Rejection overturned'
            : toTitleCase(rr.review_status || 'pending');

        return `<tr>
          <td>${i + 1}</td>
          <td style="font-size:9.5px;">${esc(rejectedByName)}<div style="color:#64748B;">at step ${rr.step_index ?? '—'}</div></td>
          <td style="font-size:9.5px;">${esc(forwardedToName)}</td>
          <td style="font-size:9.5px;white-space:pre-wrap;">${esc(rr.rejection_comments || '—')}</td>
          <td style="font-size:9.5px;white-space:pre-wrap;">${esc(rr.review_comments || '—')}</td>
          <td style="font-size:9.5px;">${esc(reviewLabel)}</td>
          <td style="font-size:9.5px;">${rr.reviewed_at ? `${formatDate(rr.reviewed_at)}<br/>${formatTime(rr.reviewed_at)}` : '—'}</td>
          <td style="font-size:9.5px;">${filesHTML}</td>
        </tr>`;
      }).join('');

      rejectionReviewsHTML = `
        <h2>Rejection Reviews</h2>
        <table>
          <thead><tr>
            <th>#</th>
            <th>Rejected By</th>
            <th>Forwarded To</th>
            <th>Rejection Reason</th>
            <th>Reviewer Response</th>
            <th>Outcome</th>
            <th>Reviewed At</th>
            <th>Files</th>
          </tr></thead>
          <tbody>${rrRows}</tbody>
        </table>
      `;
    }

    // ── Escalations ──
    // Ad-hoc "second opinion" requests an approver can raise without
    // changing the matrix. Each escalation has a question + the
    // escalated party's response. Sometimes legal/CFO weighs in here.
    let escalationsHTML = '';
    const escalations = Array.isArray(approvalRequest.escalations) ? approvalRequest.escalations : [];
    if (escalations.length) {
      const escRows = escalations.map((e, i) => {
        const byName = e.escalated_by
          ? `${e.escalated_by.first_name || ''} ${e.escalated_by.last_name || ''}`.trim() || e.escalated_by.email || '—'
          : '—';
        const toName = e.escalated_to
          ? `${e.escalated_to.first_name || ''} ${e.escalated_to.last_name || ''}`.trim() || e.escalated_to.email || '—'
          : '—';
        const filesHTML = (e.escalation_files || []).map((f) => {
          const name = esc(f.name || 'file');
          return f.url
            ? `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${name}</a>`
            : name;
        }).join(', ') || '—';

        return `<tr>
          <td>${i + 1}</td>
          <td style="font-size:9.5px;">${esc(byName)}<div style="color:#64748B;">at step ${e.step_index ?? '—'}</div></td>
          <td style="font-size:9.5px;">${esc(toName)}</td>
          <td style="font-size:9.5px;white-space:pre-wrap;">${esc(e.request_comments || '—')}</td>
          <td style="font-size:9.5px;white-space:pre-wrap;">${esc(e.comments || (e.responded_at ? '(no comment)' : '(pending)'))}</td>
          <td style="font-size:9.5px;">${e.responded_at ? `${formatDate(e.responded_at)}<br/>${formatTime(e.responded_at)}` : '—'}</td>
          <td style="font-size:9.5px;">${filesHTML}</td>
        </tr>`;
      }).join('');

      escalationsHTML = `
        <h2>Escalations / Second Opinions</h2>
        <table>
          <thead><tr>
            <th>#</th>
            <th>Escalated By</th>
            <th>To</th>
            <th>Question</th>
            <th>Response</th>
            <th>Responded At</th>
            <th>Files</th>
          </tr></thead>
          <tbody>${escRows}</tbody>
        </table>
      `;
    }

    // ── Attempt history ──
    let attemptsHTML = '';
    if (previousAttempts.length > 0) {
      const attemptRows = [];

      previousAttempts.forEach((attempt, idx) => {
        const snapshot = Array.isArray(attempt.steps_snapshot) ? attempt.steps_snapshot : [];
        const rejectedStep = snapshot.find(s => s.status === 'rejected');
        const approvedOnly = snapshot.length > 0 && snapshot.every(s => s.status === 'approved');
        const lastApproved = snapshot.filter(s => s.status === 'approved').slice(-1)[0] || null;

        let outcome = 'In Progress';
        let actor = '—';
        let at = null;

        if (rejectedStep) {
          outcome = 'Declined';
          actor = rejectedStep.approver_user_id
            ? `${rejectedStep.approver_user_id.first_name || ''} ${rejectedStep.approver_user_id.last_name || ''}`.trim() || '—'
            : '—';
          at = rejectedStep.rejected_at;
        } else if (approvedOnly && lastApproved) {
          outcome = 'Approved';
          actor = lastApproved.approver_user_id
            ? `${lastApproved.approver_user_id.first_name || ''} ${lastApproved.approver_user_id.last_name || ''}`.trim() || '—'
            : '—';
          at = lastApproved.approved_at;
        }

        attemptRows.push(`<tr>
          <td>Attempt ${attempt.attempt_number || idx + 1}</td>
          <td>${esc(outcome)}</td>
          <td>${esc(actor)}</td>
          <td style="font-size:9px;">${at ? `${formatDate(at)} ${formatTime(at)}` : '—'}</td>
        </tr>`);
      });

      const finalOutcome = toTitleCase(approvalRequest.status);
      const lastStep = steps.slice().reverse().find(s => s.approved_at || s.rejected_at) || null;
      const finalActor = lastStep?.approver_user_id
        ? `${lastStep.approver_user_id.first_name || ''} ${lastStep.approver_user_id.last_name || ''}`.trim() || '—'
        : '—';
      const finalAt = lastStep?.approved_at || lastStep?.rejected_at || approvalRequest.completed_at;

      attemptRows.push(`<tr>
        <td>Attempt ${previousAttempts.length + 1}</td>
        <td>${esc(finalOutcome)}</td>
        <td>${esc(finalActor)}</td>
        <td style="font-size:9px;">${finalAt ? `${formatDate(finalAt)} ${formatTime(finalAt)}` : '—'}</td>
      </tr>`);

      attemptsHTML = `
        <h2>Attempt History</h2>
        <table>
          <thead><tr><th>Attempt</th><th>Outcome</th><th>By</th><th>Date</th></tr></thead>
          <tbody>${attemptRows.join('')}</tbody>
        </table>
      `;
    }

    const htmlContent = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    /* Match the AIS / ACNC report style: monochrome, 1px black borders,
       Poppins, no gradients, no shadows. This produces a tight audit-
       style document — same chrome as the Annual Information Statement
       and Annual Financial Report exports so all reports look like
       one family. */
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');

    body { font-family: Poppins, sans-serif; margin: 0; padding: 0; color: #111827; }
    .container { padding: 22px; }

    .header {
      border: 1px solid #111;
      border-radius: 0;
      padding: 14px 16px;
      background: #fff;
      color: #111;
      margin-bottom: 16px;
    }
    .header-top { display: flex; align-items: center; gap: 12px; }
    .logo { height: 42px; max-width: 160px; object-fit: contain; background: #fff; padding: 0; }
    h1 { margin: 0; font-size: 18px; letter-spacing: -0.01em; }
    .subtitle { margin-top: 6px; font-size: 11px; color: #374151; line-height: 1.5; }

    h2 { margin: 18px 0 8px; font-size: 13px; color: #111; border-bottom: 1px solid #111; padding-bottom: 3px;
         break-after: avoid; page-break-after: avoid; }
    /* Never split a table row across pages — keeps approval-step rows,
       rejection-review entries and other audit rows readable in one piece. */
    tr { break-inside: avoid; page-break-inside: avoid; }
    table { -webkit-print-color-adjust: exact; }
    h3 { margin: 14px 0 8px; font-size: 12px; color: #111; }
    h4 { margin: 10px 0 6px; font-size: 11px; color: #111; }

    table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; }
    th { background: #fff; color: #111; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left; padding: 8px; border: 1px solid #111; }
    td { font-size: 10px; padding: 7px; border: 1px solid #111; vertical-align: top; color: #111; }
    .info-table td:first-child { font-weight: 600; width: 30%; }
    .no-data { color: #374151; font-size: 10px; padding: 10px; border: 1px solid #111; }
    .callout { border: 1px solid #111; background: #fff; padding: 10px; font-size: 10px; color: #111; line-height: 1.6; }

    /* Status chip — solid black border, no background colour. Keeps the
       monochrome look but still distinguishable from regular text. */
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border: 1px solid #111;
      font-weight: 600;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #111;
      background: #fff;
    }

    .signature-img {
      max-width: 260px;
      height: auto;
      border-bottom: 1px solid #111;
      margin-top: 6px;
    }

    /* Flowchart wrapper — single-line border to match the rest. */
    svg { display: block; margin: 8px auto; overflow: visible; }
    .flowchart-container {
      overflow-x: auto;
      margin: 8px 0 14px;
      padding: 10px;
      background: #fff;
      border: 1px solid #111;
    }

    .footer {
      margin-top: 18px;
      padding-top: 12px;
      border-top: 1px solid #111;
      font-size: 9px;
      color: #111;
      text-align: center;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-top">
        ${logoSrc ? `<img class="logo" src=${JSON.stringify(logoSrc)} alt="Logo" />` : ''}
        <div>
          <h1>Approval Workflow Report</h1>
          <div class="subtitle">${esc(title)} — ${esc(category)}</div>
        </div>
      </div>
    </div>

    <h2>Approval Summary</h2>
    <table class="info-table">
      <tr><td>Request Type</td><td>${esc(title)}</td></tr>
      <tr><td>Category</td><td>${esc(category)}</td></tr>
      <tr><td>Status</td><td><span class="status-badge">${esc(statusLabel)}</span></td></tr>
      <tr><td>Requested By</td><td>${esc(submittedBy)}</td></tr>
      <tr><td>Created Date</td><td>${formatDate(approvalRequest.created_at)}</td></tr>
      <tr><td>Approval Type</td><td>${esc(approvalType)}</td></tr>
      <tr><td>Total Steps</td><td>${steps.length} (${approvedSteps} approved, ${rejectedSteps} rejected, ${pendingSteps} pending)</td></tr>
    </table>

    ${entityHTML}

    ${submitterNotesHTML}

    <h2>Approval Journey</h2>
    <div class="flowchart-container">
      ${generateApprovalFlowchart(approvalRequest)}
    </div>

    <h2>Approval Steps (${steps.length})</h2>
    <table>
      <thead><tr>
        <th>Position</th>
        <th>Approver</th>
        <th>Status</th>
        <th>Date</th>
        <th>Notes</th>
      </tr></thead>
      <tbody>${stepRows}</tbody>
    </table>

    ${rejectionReviewsHTML}
    ${escalationsHTML}
    ${attemptsHTML}
    ${ackHTML}
    ${checklistHTML}
    ${finalSignatureHTML}

    <div class="footer">
      Generated on ${formatDate(new Date())} at ${formatTime(new Date())}. Confidential internal report export.
    </div>
  </div>
</body>
</html>
    `;

    // Batch callers can override the navigation policy. 'networkidle0'
    // waits for zero network activity — perfect for one-off PDFs where
    // we want every embedded image to load, but it'll hang for the
    // full 30s if any external asset is slow. The batch ZIP exporter
    // can afford a slightly less crisp render in exchange for a
    // bounded per-PDF time, so it passes waitUntil: 'load' (DOM + sync
    // assets) and a shorter timeout.
    await page.setContent(htmlContent, {
      waitUntil: options.waitUntil || 'networkidle0',
      timeout: options.timeout || 30000
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    // Always close the page we opened; only close the browser if we
    // were the ones who launched it. A batch caller stays in charge
    // of its shared browser instance.
    await page.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
    return pdfBuffer;
  } catch (error) {
    if (page) await page.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
    throw error;
  }
};
