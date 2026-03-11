/**
 * Policy Sign-Off PDF Generation Service
 * Generates professional PDF with proper data decryption and formatting
 */

import puppeteer from 'puppeteer';

/**
 * Generate Policy Sign-Off Sheet PDF
 */
export const generatePolicySignOffPDF = async (policy, acknowledgements, documentLogs, approvals, logoUrl, approvalRequest = null) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    const esc = (str) => String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Format date helper
    const formatDate = (date) => {
      if (!date) return '—';
      try {
        return new Date(date).toLocaleDateString('en-AU', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        });
      } catch (e) {
        return '—';
      }
    };

    // Format time helper
    const formatTime = (date) => {
      if (!date) return '—';
      try {
        return new Date(date).toLocaleTimeString('en-AU', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });
      } catch (e) {
        return '—';
      }
    };

    // Format text helper - removes underscores and capitalizes
    const formatText = (text) => {
      if (!text) return '—';
      return text
        .replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    };

    const safeName = (u) => {
      if (!u) return '—';
      if (typeof u === 'string') return '—';
      const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
      return name || '—';
    };

    // ── Workflow approval trail (ApprovalRequest) ──
    const ar = approvalRequest || null;
    const arSteps = Array.isArray(ar?.approval_steps) ? ar.approval_steps : [];
    const arPrevAttempts = Array.isArray(ar?.previous_attempts) ? ar.previous_attempts : [];
    const arStatus = ar?.status ? formatText(ar.status) : '—';

    const attemptOutcomeLabel = (attempt) => {
      const reason = attempt?.reason || '';
      if (reason === 'rejection_upheld') return 'Declined (Upheld)';
      if (reason === 'rejection_overridden') return 'Declined (Overridden)';
      if (reason) return formatText(reason);
      const snapshot = Array.isArray(attempt?.steps_snapshot) ? attempt.steps_snapshot : [];
      if (snapshot.some((s) => s?.status === 'rejected')) return 'Declined';
      if (snapshot.length > 0 && snapshot.every((s) => s?.status === 'approved')) return 'Approved';
      return 'In Progress';
    };

    let workflowAttemptsHTML = '';
    if (ar || arPrevAttempts.length > 0) {
      const rows = [];

      arPrevAttempts.forEach((a, idx) => {
        rows.push(`
          <tr>
            <td>Attempt ${a.attempt_number || idx + 1}</td>
            <td>${esc(attemptOutcomeLabel(a))}</td>
            <td style="font-size: 9px;">${a.change_control ? esc(a.change_control) : '—'}</td>
            <td style="font-size: 9px;">${a.saved_at ? `${formatDate(a.saved_at)}<br/><small>${formatTime(a.saved_at)}</small>` : '—'}</td>
          </tr>
        `);
      });

      rows.push(`
        <tr>
          <td>Attempt ${arPrevAttempts.length + 1}</td>
          <td>${esc(arStatus)}</td>
          <td style="font-size: 9px;">—</td>
          <td style="font-size: 9px;">${ar?.created_at ? `${formatDate(ar.created_at)}<br/><small>${formatTime(ar.created_at)}</small>` : '—'}</td>
        </tr>
      `);

      workflowAttemptsHTML = `
        <h2>Approval Workflow Attempts (${arPrevAttempts.length + 1})</h2>
        <table>
          <thead>
            <tr>
              <th style="width: 18%;">Attempt</th>
              <th style="width: 22%;">Outcome</th>
              <th style="width: 40%;">Change Control</th>
              <th style="width: 20%;">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${rows.join('')}
          </tbody>
        </table>
      `;
    }

    const renderStepRows = (steps, attemptLabel) => {
      if (!Array.isArray(steps) || steps.length === 0) return '';
      return steps.map((step, idx) => {
        let statusClass = 'status-pending';
        if (step.status === 'approved') statusClass = 'status-approved';
        if (step.status === 'rejected') statusClass = 'status-rejected';

        const isDeptHead = step.is_department_head === true;
        const posTitle = isDeptHead
          ? 'Head of Department'
          : (step.approver_position_id?.title || step.approver_department_id?.name || `Step ${idx + 1}`);
        const approverName = safeName(step.approver_user_id);
        const reviewDate = step.approved_at || step.rejected_at;

        let notes = '';
        if (step.comments) notes += `<div style="margin-top:3px;font-size:9px;color:#4A5568;">💬 ${esc(step.comments)}</div>`;
        if (step.acknowledgement_note) notes += `<div style="margin-top:3px;font-size:9px;color:#3B82F6;">📝 ${esc(step.acknowledgement_note)}</div>`;
        if (step.acknowledgement_files?.length) {
          const filesHTML = step.acknowledgement_files.map((f) => {
            const name = esc(f.name || 'file');
            const url = f.url;
            return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${name}</a>` : name;
          }).join(', ');
          notes += `<div style="margin-top:3px;font-size:9px;color:#6366F1;">📎 ${step.acknowledgement_files.length} file${step.acknowledgement_files.length !== 1 ? 's' : ''}: ${filesHTML}</div>`;
        }

        return `
          <tr>
            <td style="font-size: 9px;">${esc(attemptLabel)}</td>
            <td>${esc(posTitle)}</td>
            <td>${esc(approverName)}</td>
            <td><span class="status-badge ${statusClass}">${formatText(step.status || 'pending')}</span></td>
            <td>${reviewDate ? `${formatDate(reviewDate)}<br/><small>${formatTime(reviewDate)}</small>` : '—'}</td>
            <td style="font-size: 9px;">${notes || '—'}</td>
          </tr>
        `;
      }).join('');
    };

    let workflowStepsHTML = '';
    if ((arPrevAttempts.length > 0) || arSteps.length > 0) {
      const rows = [];
      arPrevAttempts.forEach((a, idx) => {
        const snap = Array.isArray(a.steps_snapshot) ? a.steps_snapshot : [];
        rows.push(renderStepRows(snap, `Attempt ${a.attempt_number || idx + 1}`));
      });
      rows.push(renderStepRows(arSteps, `Attempt ${arPrevAttempts.length + 1}`));

      workflowStepsHTML = `
        <h2>Approval Workflow Trail (${arPrevAttempts.length + 1} attempt${(arPrevAttempts.length + 1) !== 1 ? 's' : ''})</h2>
        ${(rows.join('').trim().length === 0)
          ? '<p class="no-data">No approval workflow steps recorded</p>'
          : `
          <table>
            <thead>
              <tr>
                <th style="width: 12%;">Attempt</th>
                <th style="width: 20%;">Position</th>
                <th style="width: 18%;">Approver</th>
                <th style="width: 12%;">Status</th>
                <th style="width: 18%;">Date & Time</th>
                <th style="width: 20%;">Notes / Evidence</th>
              </tr>
            </thead>
            <tbody>
              ${rows.join('')}
            </tbody>
          </table>
        `}
      `;
    }

    // Generate HTML content
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(180deg, #E8E0F5 0%, #FFFFFF 50%, #E8E0F5 100%);
      padding: 60px 40px;
      color: #2D3748;
      line-height: 1.6;
      min-height: 100vh;
    }
    
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    
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
    
    .subtitle {
      color: #4A5568;
      font-size: 14px;
    }
    
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
    
    tr:nth-child(even) td {
      background-color: #F7FAFC;
    }
    
    .info-table td:first-child {
      background-color: #F7FAFC;
      font-weight: 600;
      width: 25%;
    }
    
    .info-table {
      background: rgba(255, 255, 255, 0.95);
    }
    
    .signature-img {
      max-width: 150px;
      max-height: 60px;
      display: block;
      margin: 0 auto;
      border: 1px solid #E2E8F0;
      padding: 4px;
      background: white;
    }
    
    .status-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 9px;
      text-transform: uppercase;
    }
    
    .status-approved {
      background-color: #D1FAE5;
      color: #065F46;
    }
    
    .status-rejected {
      background-color: #FEE2E2;
      color: #7F1D1D;
    }
    
    .status-pending {
      background-color: #E0E7FF;
      color: #3730A3;
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
    
    .footer p {
      margin: 5px 0;
    }
    
    .no-data {
      color: #718096;
      font-size: 10px;
      padding: 12px;
      text-align: center;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="logo" />` : ''}
      <div class="header-text">
        <h1>Policy Sign-Off Sheet</h1>
        <p class="subtitle">Comprehensive Acknowledgement & Approval Log</p>
      </div>
    </div>

    <h2>Policy Details</h2>
    <table class="info-table">
      <tr>
        <td>Policy Name</td>
        <td>${policy.title || '—'}</td>
      </tr>
      <tr>
        <td>Category</td>
        <td>${policy.category || '—'}</td>
      </tr>
      <tr>
        <td>Version</td>
        <td>${policy.version || 'v1.0'}</td>
      </tr>
      <tr>
        <td>Status</td>
        <td>${formatText(policy.status || 'active')}</td>
      </tr>
      <tr>
        <td>Created Date</td>
        <td>${formatDate(policy.createdAt || policy.created_at || policy.created)}</td>
      </tr>
      <tr>
        <td>Last Review</td>
        <td>${formatDate(policy.updatedAt || policy.updated_at || policy.last_modified || policy.createdAt)}</td>
      </tr>
    </table>

    <h2>Acknowledgements Log (${acknowledgements.length})</h2>
    ${acknowledgements.length === 0 
      ? '<p class="no-data">No acknowledgements yet</p>'
      : `
    <table>
      <thead>
        <tr>
          <th style="width: 25%;">User Name</th>
          <th style="width: 20%;">Title</th>
          <th style="width: 25%;">Acknowledged Date</th>
          <th style="text-align: center; width: 30%;">E-Signature</th>
        </tr>
      </thead>
      <tbody>
        ${acknowledgements.map(ack => {
          const userName = ack.user_name || '—';
          const userTitle = ack.user_title || '—';
          const hasSignature = ack.signature_data && typeof ack.signature_data === 'string' && ack.signature_data.length > 0;
          
          return `
          <tr>
            <td>${userName}</td>
            <td>${userTitle}</td>
            <td>${formatDate(ack.acknowledged_at)}<br/><small>${formatTime(ack.acknowledged_at)}</small></td>
            <td style="text-align: center;">
              ${hasSignature 
                ? `<img src="${ack.signature_data}" class="signature-img" alt="Signature" />`
                : '<span style="color: #999; font-style: italic;">No signature</span>'
              }
            </td>
          </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    `}

    <h2>Document Update History (${documentLogs.length})</h2>
    ${documentLogs.length === 0
      ? '<p class="no-data">No updates recorded</p>'
      : `
    <table>
      <thead>
        <tr>
          <th style="width: 12%;">Update Type</th>
          <th style="width: 18%;">Updated By</th>
          <th style="width: 18%;">Date & Time</th>
          <th style="width: 10%;">Version</th>
          <th style="text-align: center; width: 22%;">E-Signature</th>
          <th style="width: 20%;">Details</th>
        </tr>
      </thead>
      <tbody>
        ${documentLogs.map(log => {
          const updaterName = log.updated_by_name || '—';
          const hasSignature = log.e_signature && typeof log.e_signature === 'string' && log.e_signature.length > 0 && log.e_signature.startsWith('data:');
          const updateType = log.action || log.update_type || log.type || 'Initial Upload';
          const details = log.description || log.changes || log.notes || log.comments || '—';
          const logDate = log.createdAt || log.created_at || log.updatedAt;
          
          return `
          <tr>
            <td>${formatText(updateType)}</td>
            <td>${updaterName}</td>
            <td>${formatDate(logDate)}<br/><small>${formatTime(logDate)}</small></td>
            <td>${log.version || '—'}</td>
            <td style="text-align: center;">
              ${hasSignature 
                ? `<img src="${log.e_signature}" class="signature-img" alt="Signature" />`
                : '<span style="color: #999; font-style: italic;">—</span>'
              }
            </td>
            <td style="font-size: 11px;">${formatText(details)}</td>
          </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    `}

    ${workflowAttemptsHTML}
    ${workflowStepsHTML}

    <h2>Policy Review Actions (${approvals.length})</h2>
    ${approvals.length === 0
      ? '<p class="no-data">No policy review actions recorded</p>'
      : `
    <table>
      <thead>
        <tr>
          <th style="width: 10%;">Step</th>
          <th style="width: 25%;">Approver</th>
          <th style="width: 15%;">Status</th>
          <th style="width: 25%;">Date & Time</th>
          <th style="width: 25%;">Comment</th>
        </tr>
      </thead>
      <tbody>
        ${approvals.map((approval, idx) => {
          const approverName = approval.approver_name || approval.reviewed_by_name || '—';
          const reviewDate = approval.reviewed_at || approval.created_at;
          let statusClass = 'status-pending';
          if (approval.status === 'approved') statusClass = 'status-approved';
          if (approval.status === 'rejected') statusClass = 'status-rejected';
          const comment = approval.comments || approval.action || '—';
          
          return `
          <tr>
            <td>Step ${approval.step || idx + 1}</td>
            <td>${approverName}</td>
            <td><span class="status-badge ${statusClass}">${formatText(approval.status || 'pending')}</span></td>
            <td>${reviewDate ? `${formatDate(reviewDate)}<br/><small>${formatTime(reviewDate)}</small>` : '—'}</td>
            <td style="font-size: 11px;">${formatText(comment)}</td>
          </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    `}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())} at ${formatTime(new Date())}</p>
      <p>This policy sign-off sheet contains a comprehensive audit trail of all acknowledgements, updates, and approvals.</p>
      <p>Charity Compliance Management System | Confidential Document</p>
    </div>
  </div>
</body>
</html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 0 });
    
    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });

    await browser.close();

    return pdfBuffer;
  } catch (error) {
    await browser.close();
    throw error;
  }
};
