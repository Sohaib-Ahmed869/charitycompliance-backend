/**
 * Audit Trail PDF Generation Service
 * Generates professional PDF using Puppeteer (same pattern as policySignOffPdfService)
 */

import puppeteer from 'puppeteer';
import { resolveLogoSrcForPdf } from '../utils/pdfLogo.js';

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
  asset: 'Assets & IT',
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
  const logoSrc = await resolveLogoSrcForPdf(logoUrl);

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
      ${logoSrc ? `<img src=${JSON.stringify(logoSrc)} alt="Logo" class="logo" />` : ''}
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

// ────────────────────────────────────────────────────────────────────
// generateAuditTrailReportPdf
// ────────────────────────────────────────────────────────────────────
// Bulk audit-trail report — one PDF covering EVERY audit event the
// caller passed in (workflows, COI declarations, document uploads,
// board changes, financial-threshold edits, complaint events, etc.).
// Used by POST /platform/audit-trail/export-pdf. The caller has
// already applied filters; we just render what's handed to us.
// ────────────────────────────────────────────────────────────────────

const REPORT_MODULE_LABELS = {
  approval_workflow:    'Approval Workflows',
  coi:                  'Conflict of Interest',
  complaint:            'Complaints',
  governing_document:   'Governing Documents',
  legal_document:       'Legal Documents',
  board_member:         'Board Members',
  financial_thresholds: 'Financial Thresholds',
  policy:               'Policies & Procedures',
  risk:                 'Risk Register',
  training:             'Training',
  hr:                   'Human Resources',
  expense:              'Financial Management',
  finance:              'Financial Management',
  donor:                'Donors',
  funding_agreement:    'Funding Agreements',
  project:              'Projects',
  asset:                'Assets',
  responsible_people:   'Responsible People',
  users:                'Users',
  support_ticket:       'Support Tickets',
  grant:                'Grants & Funders'
};

const reportModuleLabel = (m) => REPORT_MODULE_LABELS[m] || toTitleCase(m || 'Other');

function reportFormatTs(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// Render event.details into readable HTML — skip internal id fields,
// turn file arrays into link lists, format primitives cleanly.
function renderReportDetails(details) {
  if (!details || typeof details !== 'object') return '';
  const SKIP = new Set([
    'parent_approval_request_id', 'parent_request_id', 'request_id',
    'entity_id', 'coi_request_id'
  ]);
  const pairs = [];
  for (const [key, raw] of Object.entries(details)) {
    if (SKIP.has(key)) continue;
    if (raw === null || raw === undefined || raw === '') continue;
    const label = toTitleCase(key);
    let value;
    if (Array.isArray(raw)) {
      if (!raw.length) continue;
      if (raw.every((v) => v && typeof v === 'object' && (v.url || v.name))) {
        value = raw.map((f) => f.url
          ? `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" style="color:#1D4ED8;text-decoration:underline;">${esc(f.name || 'file')}</a>`
          : esc(f.name || 'file')).join(', ');
      } else {
        value = raw.map((v) => esc(typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
      }
    } else if (typeof raw === 'object') {
      value = `<code style="font-size:9px;color:#475569;">${esc(JSON.stringify(raw))}</code>`;
    } else if (typeof raw === 'boolean') {
      value = raw ? 'Yes' : 'No';
    } else {
      value = esc(String(raw));
    }
    pairs.push(`<div style="margin-top:2px;"><span style="color:#475569;font-weight:600;">${esc(label)}:</span> ${value}</div>`);
  }
  return pairs.join('');
}

function renderReportActor(actor) {
  if (!actor || typeof actor !== 'object') return '—';
  const name = esc(actor.name || '—');
  const role = actor.role ? `<div style="color:#64748b;font-size:9px;">${esc(toTitleCase(actor.role))}</div>` : '';
  return `${name}${role}`;
}

export async function generateAuditTrailReportPdf({ events = [], filters = {}, org, orgLogoUrl = '' }) {
  const logoSrc = await resolveLogoSrcForPdf(orgLogoUrl);

  // ── Aggregates ─────────────────────────────────────────────────
  const total = events.length;
  const perModule = new Map();
  let earliest = null;
  let latest = null;
  for (const e of events) {
    const m = e.module || 'other';
    perModule.set(m, (perModule.get(m) || 0) + 1);
    const t = new Date(e.timestamp);
    if (!Number.isNaN(t.getTime())) {
      if (!earliest || t < earliest) earliest = t;
      if (!latest || t > latest) latest = t;
    }
  }
  const moduleRows = Array.from(perModule.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<tr><td>${esc(reportModuleLabel(m))}</td><td style="text-align:right;font-weight:600;">${n}</td></tr>`)
    .join('');

  // ── Event rows ────────────────────────────────────────────────
  const eventRows = events.map((e) => {
    const detailsHTML = renderReportDetails(e.details);
    const entityTitle = e.details?.entity_title
      ? `<div style="font-weight:600;margin-bottom:2px;">${esc(e.details.entity_title)}</div>`
      : '';
    return `
      <tr>
        <td style="vertical-align:top;font-size:9.5px;white-space:nowrap;">${esc(reportFormatTs(e.timestamp))}</td>
        <td style="vertical-align:top;font-size:9.5px;">${renderReportActor(e.actor)}</td>
        <td style="vertical-align:top;font-size:9.5px;">
          <span class="rpt-mod-chip">${esc(reportModuleLabel(e.module))}</span>
        </td>
        <td style="vertical-align:top;font-size:10px;">
          <div style="font-weight:600;color:#0a2540;">${esc(e.action || '—')}</div>
        </td>
        <td style="vertical-align:top;font-size:9.5px;color:#1f2937;">
          ${entityTitle}${detailsHTML || '<span style="color:#94a3b8;">—</span>'}
        </td>
      </tr>
    `;
  }).join('');

  const filterSummary = Object.entries(filters)
    .filter(([, v]) => v != null && v !== '' && v !== 'all')
    .map(([k, v]) => `<span class="rpt-filter-pill"><strong>${esc(toTitleCase(k))}:</strong> ${esc(String(v))}</span>`)
    .join(' ');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');
  body { font-family: Poppins, sans-serif; margin: 0; color: #0a2540; }
  .rpt-container { padding: 22px; }
  .rpt-header { display: flex; gap: 14px; align-items: center; border: 1px solid #111; padding: 14px 18px; }
  .rpt-header img { height: 42px; }
  .rpt-header h1 { margin: 0; font-size: 18px; }
  .rpt-header .sub { color: #64748b; font-size: 11px; margin-top: 2px; }
  .rpt-filter-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #f1f5f9; color: #334155; font-size: 10.5px; margin-right: 4px; }
  .rpt-mod-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: 9.5px; font-weight: 600; white-space: nowrap; }
  h2 { margin: 18px 0 8px; font-size: 13px; color: #111; border-bottom: 1px solid #111; padding-bottom: 3px; break-after: avoid; page-break-after: avoid; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
  th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .rpt-info-table td:first-child { width: 32%; color: #475569; font-weight: 600; }
  .rpt-footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #e5e7eb; color: #64748b; font-size: 9.5px; text-align: center; }
</style>
</head>
<body>
  <div class="rpt-container">

    <div class="rpt-header">
      ${logoSrc ? `<img src="${esc(logoSrc)}" alt="" />` : ''}
      <div>
        <h1>Audit Trail Report</h1>
        <div class="sub">${esc(org?.name || org?.legal_name || 'Organisation')}</div>
      </div>
    </div>

    <h2>Report Summary</h2>
    <table class="rpt-info-table">
      <tr><td>Generated</td><td>${esc(reportFormatTs(new Date()))}</td></tr>
      <tr><td>Total audit entries</td><td><strong>${total}</strong></td></tr>
      <tr><td>Date range covered</td><td>${earliest ? esc(reportFormatTs(earliest)) : '—'} &rarr; ${latest ? esc(reportFormatTs(latest)) : '—'}</td></tr>
      <tr><td>Filters applied</td><td>${filterSummary || '<span style="color:#94a3b8;">None &mdash; full register</span>'}</td></tr>
    </table>

    <h2>Entries by Module</h2>
    <table>
      <thead><tr><th>Module</th><th style="text-align:right;">Entries</th></tr></thead>
      <tbody>${moduleRows || '<tr><td colspan="2" style="text-align:center;color:#94a3b8;">No events.</td></tr>'}</tbody>
    </table>

    <h2>Audit Log (${total} ${total === 1 ? 'entry' : 'entries'})</h2>
    <table>
      <thead>
        <tr>
          <th style="width:14%;">Timestamp</th>
          <th style="width:16%;">Actor</th>
          <th style="width:14%;">Module</th>
          <th style="width:20%;">Action</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>${eventRows || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No audit entries match the current filters.</td></tr>'}</tbody>
    </table>

    <div class="rpt-footer">
      Generated by Stewardex on ${esc(reportFormatTs(new Date()))}. Confidential &mdash; for internal audit use.
    </div>
  </div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdf = await page.pdf({
      format: 'A4',
      landscape: true, // wide layout — five columns need the room
      printBackground: true,
      margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' }
    });
    await page.close().catch(() => {});
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}
