/**
 * Approval Detail PDF Generation Service
 * Generates professional PDF using Puppeteer (same pattern as policySignOffPdfService)
 */

import puppeteer from 'puppeteer';

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
  hr: 'Human Resources',
  other: 'Compliance',
};

/**
 * @param {Object} approvalRequest – Full approval request (populated)
 * @param {Object} expense         – Expense entity (or null)
 * @param {Object} risk            – Risk entity (or null)
 * @param {string} logoUrl
 */
export const generateApprovalPDF = async (approvalRequest, expense, risk, logoUrl) => {
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
        notes += `<div style="margin-top:3px;font-size:9px;color:#4A5568;">💬 ${esc(step.comments)}</div>`;
      }
      if (step.acknowledgement_note) {
        notes += `<div style="margin-top:3px;font-size:9px;color:#3B82F6;">📝 ${esc(step.acknowledgement_note)}</div>`;
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
        notes += `<div style="margin-top:3px;font-size:9px;color:#6366F1;">📎 ${step.acknowledgement_files.length} file${step.acknowledgement_files.length !== 1 ? 's' : ''}: ${filesHTML}</div>`;
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
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(180deg, #E8E0F5 0%, #FFFFFF 50%, #E8E0F5 100%);
      padding: 60px 40px;
      color: #2D3748;
      line-height: 1.6;
      min-height: 100vh;
    }
    
    .container { max-width: 900px; margin: 0 auto; }
    
    .header {
      text-align: center;
      margin-bottom: 40px;
      padding-bottom: 30px;
      border-bottom: 3px solid #3485FF;
    }
    
    .logo {
      max-height: 100px;
      max-width: 250px;
      margin-bottom: 20px;
      display: block;
      margin-left: auto;
      margin-right: auto;
    }
    
    h1 {
      font-family: 'Poppins', sans-serif;
      color: #132E5E;
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    
    .subtitle { color: #4A5568; font-size: 14px; }
    
    h2 {
      font-family: 'Poppins', sans-serif;
      color: #132E5E;
      font-size: 14px;
      font-weight: 600;
      margin: 25px 0 12px 0;
      padding-bottom: 8px;
      border-bottom: 2px solid #3485FF;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 25px;
      font-size: 10px;
      background: rgba(255, 255, 255, 0.9);
      border-radius: 8px;
      overflow: hidden;
    }
    
    th {
      background-color: #EDF2F7;
      padding: 10px;
      text-align: left;
      font-weight: 600;
      color: #2D3748;
      border: 1px solid #CBD5E0;
      font-size: 10px;
    }
    
    td {
      padding: 8px;
      border: 1px solid #E2E8F0;
      color: #4A5568;
      background: white;
      font-size: 10px;
    }
    
    tr:nth-child(even) td { background-color: #F7FAFC; }
    
    .info-table td:first-child {
      background-color: #F7FAFC;
      font-weight: 600;
      width: 25%;
    }
    
    .info-table { background: rgba(255, 255, 255, 0.95); }
    
    .status-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 9px;
      text-transform: uppercase;
    }
    
    .status-approved { background-color: #D1FAE5; color: #065F46; }
    .status-rejected { background-color: #FEE2E2; color: #7F1D1D; }
    .status-pending { background-color: #E0E7FF; color: #3730A3; }
    
    .signature-img {
      max-width: 260px;
      height: auto;
      border-bottom: 1px solid #CBD5E0;
      margin-top: 6px;
    }
    
    .footer {
      margin-top: 40px;
      padding: 15px 0;
      border-top: 2px solid #E2E8F0;
      text-align: center;
      color: #718096;
      font-size: 9px;
      line-height: 1.8;
    }
    
    .footer p { margin: 5px 0; }
  </style>
</head>
<body>
    <div class="container">
    <div class="header">
      ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="logo" />` : ''}
      <h1>Approval Workflow Report</h1>
      <p class="subtitle">${esc(title)} — ${esc(category)}</p>
    </div>

    <h2>Approval Summary</h2>
    <table class="info-table">
      <tr><td>Request Type</td><td>${esc(title)}</td></tr>
      <tr><td>Category</td><td>${esc(category)}</td></tr>
      <tr><td>Status</td><td>${esc(statusLabel)}</td></tr>
      <tr><td>Requested By</td><td>${esc(submittedBy)}</td></tr>
      <tr><td>Created Date</td><td>${formatDate(approvalRequest.created_at)}</td></tr>
      <tr><td>Approval Type</td><td>${esc(approvalType)}</td></tr>
      <tr><td>Total Steps</td><td>${steps.length} (${approvedSteps} approved, ${rejectedSteps} rejected, ${pendingSteps} pending)</td></tr>
    </table>

    ${entityHTML}

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
    ${finalSignatureHTML}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())} at ${formatTime(new Date())}</p>
      <p>This approval workflow report contains a comprehensive log of all steps, decisions, and acknowledgements related to this request.</p>
      <p>Charity Compliance Management System | Confidential Document</p>
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
