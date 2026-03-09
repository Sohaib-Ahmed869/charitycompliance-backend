/**
 * Audit Trail PDF Generation Service
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
  if (amount == null) return null;
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount);
};

const MODULE_MAP = {
  risk: 'Governance & Risk',
  policy: 'Policies & Procedures',
  expense: 'Financial Management',
  grant: 'Grants & Funders',
  hr: 'Human Resources',
  coi: 'Conflict of Interest',
  complaint: 'Complaints',
};
const getModuleLabel = (m) => MODULE_MAP[m] || 'General';

const EVENT_COLORS = {
  submitted: '#4F46E5',
  approved: '#059669',
  rejected: '#DC2626',
  forwarded: '#D97706',
  coi: '#0D9488',
  paused: '#7C3AED',
  info: '#6B7280',
};

const getEventType = (event) => {
  const action = (event.action || '').toLowerCase();
  if (event.module === 'coi' || event.request_type === 'coi') return 'coi';
  if (action.includes('forwarded')) return 'forwarded';
  if (action.includes('rejected') || action.includes('declined')) return 'rejected';
  if (action.includes('approved')) return 'approved';
  if (action.includes('submitted')) return 'submitted';
  if (action.includes('paused')) return 'paused';
  if (action.includes('resolved')) return 'approved';
  return 'info';
};

const getEventColor = (type) => EVENT_COLORS[type] || '#6B7280';

const getEventLabel = (event) => {
  if (event.module === 'coi' || event.request_type === 'coi') {
    const a = (event.action || '').toLowerCase();
    if (a.includes('submitted')) return 'COI Submitted';
    if (a.includes('rejected')) return 'COI Rejected';
    if (a.includes('approved')) return 'COI Approved';
    return 'COI Review';
  }
  if ((event.action || '').toLowerCase().includes('forwarded')) {
    return event.details?.forwarded_to ? `Forwarded to ${event.details.forwarded_to}` : 'Forwarded';
  }
  if ((event.action || '').toLowerCase().includes('submitted')) return 'Request Submitted';
  if ((event.action || '').toLowerCase().includes('paused for coi')) return 'Paused for COI';
  if (event.step?.position) return event.step.position;
  return event.action || 'Workflow Update';
};

const getOverallStatusLabel = (events) => {
  const actions = events.map(e => (e.action || '').toLowerCase());
  if (actions.some(a => a.includes('resolved'))) return 'Resolved';
  if (actions.some(a => a.includes('rejected') || a.includes('declined'))) return 'Rejected';
  if (actions.some(a => a.includes('approved'))) return 'Approved';
  if (actions.some(a => a.includes('paused'))) return 'Paused';
  if (actions.some(a => a.includes('forwarded'))) return 'In Review';
  if (actions.some(a => a.includes('submitted'))) return 'Submitted';
  return 'In Progress';
};

const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {Array}  allEvents      – Sorted events for one request_id
 * @param {Array}  uniqueActors   – Array of actor name strings
 * @param {Object} entityInfo     – { entityTitle, entityCategory, amount, vendor, approvalType, submittedBy, submittedByRole }
 * @param {string} module         – e.g. 'expense', 'risk', 'policy'
 * @param {string} requestId
 * @param {string} logoUrl
 */
export const generateAuditTrailPDF = async (allEvents, uniqueActors, entityInfo, module, requestId, logoUrl) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    const statusLabel = getOverallStatusLabel(allEvents);
    const moduleLabel = getModuleLabel(module);
    const firstEvent = allEvents[0];
    const lastEvent = allEvents[allEvents.length - 1];
    const { entityTitle = '—', entityCategory, amount, vendor, approvalType, submittedBy = '—', submittedByRole = '' } = entityInfo || {};

    // ── Summary rows ──
    let summaryRows = `
      <tr><td>Module</td><td>${esc(moduleLabel)}</td></tr>
      <tr><td>Status</td><td>${esc(statusLabel)}</td></tr>
      <tr><td>Submitted By</td><td>${esc(submittedBy)}${submittedByRole ? ` (${esc(submittedByRole)})` : ''}</td></tr>
      <tr><td>Timeline</td><td>${formatDate(firstEvent?.timestamp)} → ${formatDate(lastEvent?.timestamp)}</td></tr>
      <tr><td>Total Actions</td><td>${allEvents.length} action${allEvents.length !== 1 ? 's' : ''} · ${uniqueActors.length} participant${uniqueActors.length !== 1 ? 's' : ''}</td></tr>
      <tr><td>Request ID</td><td style="font-size:9px;">${esc(requestId)}</td></tr>
    `;
    if (entityTitle !== '—') summaryRows += `<tr><td>Title / Entity</td><td>${esc(entityTitle)}</td></tr>`;
    if (entityCategory && entityCategory !== '—') summaryRows += `<tr><td>Category</td><td>${esc(toTitleCase(entityCategory))}</td></tr>`;
    if (amount != null) summaryRows += `<tr><td>Amount</td><td>${formatCurrency(amount)}</td></tr>`;
    if (vendor) summaryRows += `<tr><td>Vendor</td><td>${esc(vendor)}</td></tr>`;
    if (approvalType) summaryRows += `<tr><td>Approval Type</td><td>${esc(toTitleCase(approvalType))}</td></tr>`;

    // ── Participants table ──
    let participantsHTML = '';
    if (uniqueActors.length > 0) {
      let rows = '';
      uniqueActors.forEach(actor => {
        const actorName = typeof actor === 'string' ? actor : actor?.name || '—';
        const actorEvents = allEvents.filter(e => e.actor?.name === actorName);
        const role = (typeof actor === 'object' ? actor?.role : null) || actorEvents[0]?.actor?.role || '—';
        const count = actorEvents.length;
        const lastAction = actorEvents[actorEvents.length - 1]?.action || '—';
        rows += `<tr>
          <td>${esc(actorName)}</td>
          <td>${esc(role)}</td>
          <td style="text-align:center;">${count}</td>
          <td style="font-size:9px;">${esc(lastAction)}</td>
        </tr>`;
      });

      participantsHTML = `
        <h2>Participants (${uniqueActors.length})</h2>
        <table>
          <thead><tr>
            <th>Name</th><th>Role</th><th style="text-align:center;">Actions</th><th>Last Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    // ── Timeline table ──
    let timelineRows = '';
    allEvents.forEach(event => {
      const type = getEventType(event);
      const color = getEventColor(type);
      const label = getEventLabel(event);
      const details = event.details || {};
      const isCoi = event.module === 'coi' || event.request_type === 'coi';

      let notes = '';
      const comment = details.comments || details.reason || details.review_comments;
      if (comment) {
        notes += `<div class="note" style="border-left-color:${color};">${esc(comment)}</div>`;
      }
      if (details.acknowledgement_note) {
        notes += `<div class="note" style="border-left-color:#3B82F6;background:#EFF6FF;"><strong>Acknowledgement:</strong> ${esc(details.acknowledgement_note)}</div>`;
      }
      if (details.forwarded_to) {
        notes += `<div style="margin-top:3px;font-size:9px;color:#92400E;">→ Forwarded to ${esc(details.forwarded_to)}</div>`;
      }
      if (details.acknowledgement_files?.length) {
        notes += `<div style="margin-top:3px;font-size:9px;color:#6366F1;">📎 ${details.acknowledgement_files.length} file${details.acknowledgement_files.length !== 1 ? 's' : ''}: ${details.acknowledgement_files.map(f => esc(f.name || 'file')).join(', ')}</div>`;
      }

      timelineRows += `<tr>
        <td style="white-space:nowrap;vertical-align:top;font-size:9px;">
          ${formatDate(event.timestamp)}<br/><span style="color:#9CA3AF;">${formatTime(event.timestamp)}</span>
        </td>
        <td style="vertical-align:top;">
          <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;">
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};flex-shrink:0;"></span>
            <span style="font-weight:600;font-size:10px;color:#1F2937;">${esc(label)}</span>
            ${isCoi ? '<span class="status-badge" style="background:#CCFBF1;color:#115E59;margin-left:4px;">COI</span>' : ''}
          </div>
          ${notes}
        </td>
        <td style="vertical-align:top;">${esc(event.actor?.name || '—')}</td>
        <td style="vertical-align:top;font-size:9px;">${esc(event.actor?.role || '—')}</td>
      </tr>`;
    });

    // ── Attachments summary ──
    const allAttachments = [];
    allEvents.forEach(event => {
      if (event.details?.acknowledgement_files?.length) {
        event.details.acknowledgement_files.forEach(f => {
          allAttachments.push({ name: f.name || 'file', actor: event.actor?.name || '—', size: f.size, timestamp: event.timestamp });
        });
      }
    });

    let attachmentsHTML = '';
    if (allAttachments.length > 0) {
      let rows = '';
      allAttachments.forEach(file => {
        rows += `<tr>
          <td>${esc(file.name)}</td>
          <td>${esc(file.actor)}</td>
          <td>${file.size ? `${(file.size / 1024).toFixed(1)} KB` : '—'}</td>
          <td>${formatDate(file.timestamp)}</td>
        </tr>`;
      });

      attachmentsHTML = `
        <h2>All Attachments (${allAttachments.length})</h2>
        <table>
          <thead><tr><th>File Name</th><th>Uploaded By</th><th>Size</th><th>Date</th></tr></thead>
          <tbody>${rows}</tbody>
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
    
    .note {
      margin-top: 4px;
      padding: 4px 8px;
      background: #F7FAFC;
      border-left: 3px solid #6B7280;
      border-radius: 3px;
      font-size: 9px;
      color: #4A5568;
    }
    
    .status-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 700;
      font-size: 8px;
      text-transform: uppercase;
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
      <h1>Audit Trail Report</h1>
      <p class="subtitle">Complete Governance & Compliance Audit Log</p>
    </div>

    <h2>Request Summary</h2>
    <table class="info-table">
      ${summaryRows}
    </table>

    ${participantsHTML}

    <h2>Complete Audit Timeline (${allEvents.length} events)</h2>
    <table>
      <thead><tr>
        <th style="width:100px;">Date & Time</th>
        <th>Event</th>
        <th style="width:120px;">Actor</th>
        <th style="width:100px;">Role</th>
      </tr></thead>
      <tbody>${timelineRows}</tbody>
    </table>

    ${attachmentsHTML}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())} at ${formatTime(new Date())}</p>
      <p>This audit trail report contains a comprehensive log of all actions, reviews, and decisions related to this request.</p>
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
