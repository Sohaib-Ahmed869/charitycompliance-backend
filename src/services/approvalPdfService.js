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
export const generateApprovalPDF = async (approvalRequest, expense, risk, logoUrl, checklistInstance = null) => {
  // Refresh all S3 file URLs to ensure they are not expired
  ({ approvalRequest, checklistInstance } = await refreshApprovalFileUrls(approvalRequest, checklistInstance));

  const logoSrc = await resolveLogoSrcForPdf(logoUrl);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

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

    h2 { margin: 18px 0 8px; font-size: 13px; color: #111; border-bottom: 1px solid #111; padding-bottom: 3px; }
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

    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    await browser.close();
    return pdfBuffer;
  } catch (error) {
    await browser.close();
    throw error;
  }
};
