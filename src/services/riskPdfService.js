/**
 * Risk PDF Generation Service
 * Mirrors the visual style of policy / training PDFs.
 */

import puppeteer from 'puppeteer';
import { resolveLogoSrcForPdf } from '../utils/pdfLogo.js';

const formatDate = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('en-AU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch {
    return '—';
  }
};

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;'
}[c]));

const formatText = (text) => {
  if (!text) return '—';
  return String(text)
    .replace(/_/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Aggregate risks into a 5x5 consequence × likelihood grid. grid[c][l] is the
 * count of risks at consequence (c+1) and likelihood (l+1).
 */
const buildHeatMapGrid = (risks) => {
  const grid = Array(5).fill(null).map(() => Array(5).fill(0));
  for (const r of risks || []) {
    const c = Math.min(5, Math.max(1, Number(r.consequence) || 1)) - 1;
    const l = Math.min(5, Math.max(1, Number(r.likelihood) || 1)) - 1;
    grid[c][l] += 1;
  }
  return grid;
};

/**
 * Color tokens for each cell, keyed off the consequence × likelihood score.
 * Mirrors the bands used in the live dashboard so the printed chart looks
 * the same as what the user sees on screen.
 */
const heatMapCellTokens = (score) => {
  if (!score) return { bg: '#F1F5F9', fg: '#94A3B8', border: '#E2E8F0' };
  if (score <= 4) return { bg: '#DCFCE7', fg: '#166534', border: '#BBF7D0' };
  if (score <= 8) return { bg: '#ECFCCB', fg: '#3F6212', border: '#D9F99D' };
  if (score <= 12) return { bg: '#FEF3C7', fg: '#92400E', border: '#FDE68A' };
  if (score <= 16) return { bg: '#FFEDD5', fg: '#9A3412', border: '#FED7AA' };
  if (score <= 20) return { bg: '#FEE2E2', fg: '#991B1B', border: '#FECACA' };
  return { bg: '#FCA5A5', fg: '#7F1D1D', border: '#F87171' };
};

export const generateRiskDetailPDF = async (payload, logoUrl, options = {}) => {
  const logoSrc = await resolveLogoSrcForPdf(logoUrl);

  // Allow a caller (e.g. the ZIP export) to pass a shared browser so we don't
  // launch one puppeteer instance per risk.
  const externalBrowser = options.browser || null;
  const browser = externalBrowser || await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const { risk, org } = payload || {};
    const title = risk?.title || 'Risk';

    const attachments = Array.isArray(risk?.attachments) ? risk.attachments : [];
    const treatments = Array.isArray(risk?.treatments) ? risk.treatments : [];

    const attachmentsHTML = attachments.length === 0
      ? '<p class="no-data">No attachments uploaded for this risk.</p>'
      : `
      <table>
        <thead>
          <tr>
            <th style="width:5%;">#</th>
            <th style="width:45%;">File Name</th>
            <th style="width:20%;">Type</th>
            <th style="width:15%;">Size</th>
            <th style="width:15%;">Link</th>
          </tr>
        </thead>
        <tbody>
          ${attachments.map((att, idx) => {
            const sizeKb = att.file_size ? `${(att.file_size / 1024).toFixed(1)} KB` : '—';
            const url = att.url || '';
            return `
              <tr>
                <td>${idx + 1}</td>
                <td>${esc(att.file_name || '')}</td>
                <td>${esc(att.mime_type || '')}</td>
                <td>${sizeKb}</td>
                <td>${url ? `<a href="${esc(url)}" target="_blank">Open</a>` : '—'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    const treatmentsHTML = treatments.length === 0
      ? '<p class="no-data">No treatments or control actions recorded for this risk.</p>'
      : `
      <table>
        <thead>
          <tr>
            <th style="width:5%;">#</th>
            <th style="width:30%;">Control Action</th>
            <th style="width:15%;">Owner</th>
            <th style="width:15%;">Due Date</th>
            <th style="width:15%;">Status</th>
            <th style="width:20%;">Evidence</th>
          </tr>
        </thead>
        <tbody>
          ${treatments.map((t, idx) => {
            const ev = Array.isArray(t.evidence) ? t.evidence : [];
            const evHtml = ev.length === 0
              ? '—'
              : ev.map((e, i) => {
                const label = e.file_name || `Evidence ${i + 1}`;
                return e.url
                  ? `<a href="${esc(e.url)}" target="_blank">${esc(label)}</a>`
                  : esc(label);
              }).join('<br/>');
            return `
              <tr>
                <td>${idx + 1}</td>
                <td>${esc(t.control_action || '')}</td>
                <td>${esc(t.owner || '')}</td>
                <td>${formatDate(t.due_date)}</td>
                <td>${formatText(t.status || 'pending')}</td>
                <td style="font-size:9px;">${evHtml}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

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
      background: linear-gradient(180deg,#E8E0F5 0%,#FFFFFF 50%,#E8E0F5 100%);
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
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #4A5568;
      font-size: 13px;
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
      margin-bottom: 20px;
      font-size: 10px;
      background: rgba(255,255,255,0.9);
      border-radius: 8px;
      overflow: hidden;
    }
    th {
      background-color: #EDF2F7;
      padding: 8px;
      text-align: left;
      font-weight: 600;
      color: #2D3748;
      border: 1px solid #CBD5E0;
      font-size: 10px;
    }
    td {
      padding: 7px;
      border: 1px solid #E2E8F0;
      color: #4A5568;
      background: white;
      font-size: 10px;
    }
    tr:nth-child(even) td { background-color: #F7FAFC; }
    .info-table td:first-child {
      background-color: #F7FAFC;
      font-weight: 600;
      width: 28%;
    }
    .info-table { background: rgba(255,255,255,0.95); }
    .no-data {
      color: #718096;
      font-size: 10px;
      padding: 12px;
      text-align: center;
      font-style: italic;
      background: rgba(255,255,255,0.9);
      border-radius: 8px;
    }
    .footer {
      margin-top: 30px;
      padding: 15px 0;
      border-top: 2px solid #E2E8F0;
      text-align: center;
      color: #718096;
      font-size: 9px;
      line-height: 1.8;
    }
    .footer p { margin: 4px 0; }
    a {
      color: #1D4ED8;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${logoSrc ? `<img src=${JSON.stringify(logoSrc)} alt="Logo" class="logo" />` : ''}
      <h1>Risk Detail Report</h1>
      <p class="subtitle">${esc(title)}</p>
    </div>

    <h2>Risk Summary</h2>
    <table class="info-table">
      <tr><td>Title</td><td>${esc(risk?.title || '')}</td></tr>
      <tr><td>Category</td><td>${esc(risk?.category || '')}</td></tr>
      <tr><td>Department</td><td>${esc(risk?.department || '—')}</td></tr>
      <tr><td>Owner</td><td>${esc(risk?.risk_owner_board_member_id?.name || risk?.risk_owner_name || '—')}</td></tr>
      <tr><td>Status</td><td>${formatText(risk?.status || 'draft')}</td></tr>
      <tr><td>Trend</td><td>${formatText(risk?.trend || 'stable')}</td></tr>
      <tr><td>Next Review Date</td><td>${formatDate(risk?.next_review_date)}</td></tr>
    </table>

    <h2>Risk Ratings</h2>
    <table class="info-table">
      <tr><td>Likelihood</td><td>${risk?.likelihood ?? '—'}</td></tr>
      <tr><td>Consequence</td><td>${risk?.consequence ?? '—'}</td></tr>
      <tr><td>Inherent Risk Score</td><td>${risk?.inherent_risk_score ?? '—'} (${formatText(risk?.inherent_risk_level)})</td></tr>
      <tr><td>Residual Risk Score</td><td>${risk?.residual_risk_score ?? '—'} ${risk?.residual_risk_level ? `(${formatText(risk.residual_risk_level)})` : ''}</td></tr>
    </table>

    <h2>Description & Existing Controls</h2>
    <table class="info-table">
      <tr><td>Description</td><td>${esc(risk?.description || '—')}</td></tr>
      <tr><td>Existing Controls</td><td>${esc(risk?.existing_controls || '—')}</td></tr>
    </table>

    <h2>Attachments (${attachments.length})</h2>
    ${attachmentsHTML}

    <h2>Treatments & Evidence (${treatments.length})</h2>
    ${treatmentsHTML}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())}</p>
      <p>Organisation: ${esc(org?.name || '')}</p>
      <p>Charity Compliance Management System | Confidential Document</p>
    </div>
  </div>
</body>
</html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 0 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });
    await page.close().catch(() => {});
    if (!externalBrowser) await browser.close();
    return pdfBuffer;
  } catch (error) {
    if (!externalBrowser) await browser.close();
    throw error;
  }
};

export const generateRiskRegisterPDF = async (payload, logoUrl) => {
  const logoSrc = await resolveLogoSrcForPdf(logoUrl);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const { risks = [], org } = payload || {};

    const rowsHtml = risks.length === 0
      ? ''
      : risks.map((r, idx) => `
        <tr>
          <td>${idx + 1}</td>
          <td>${esc(r.title || '')}</td>
          <td>${esc(r.category || '')}</td>
          <td>${esc(r.department || '—')}</td>
          <td>${formatText(r.status || 'draft')}</td>
          <td>${formatText(r.inherent_risk_level || '')}</td>
          <td>${formatText(r.residual_risk_level || '')}</td>
        </tr>
      `).join('');

    // ---- Heat map ----
    // Render top-down so that the highest consequence (5) sits on top, matching
    // the on-screen chart. Likelihood runs left-to-right 1..5.
    const grid = buildHeatMapGrid(risks);
    const heatRowsHtml = [4, 3, 2, 1, 0].map((rowIdx) => {
      const cells = [0, 1, 2, 3, 4].map((colIdx) => {
        const score = (rowIdx + 1) * (colIdx + 1);
        const count = grid[rowIdx][colIdx];
        const t = heatMapCellTokens(score);
        return `
          <td class="heat-cell" style="background:${t.bg};color:${t.fg};border:1px solid ${t.border};">
            <div class="heat-count">${count > 0 ? count : ''}</div>
            <div class="heat-score">${score}</div>
          </td>`;
      }).join('');
      return `
        <tr>
          <th class="heat-axis-y">${rowIdx + 1}</th>
          ${cells}
        </tr>`;
    }).join('');

    // Severity totals (matches the dashboard's "By Severity" cards) so the
    // printed heat map carries the same headline numbers.
    const sevTallies = { critical: 0, extreme: 0, high: 0, moderate: 0, low: 0 };
    for (const r of risks) {
      const lvl = r.residual_risk_level;
      if (sevTallies[lvl] !== undefined) sevTallies[lvl] += 1;
    }
    const sevCardsHtml = [
      { key: 'critical', label: 'Critical', tone: 'red' },
      { key: 'extreme',  label: 'Extreme',  tone: 'red' },
      { key: 'high',     label: 'High',     tone: 'amber' },
      { key: 'moderate', label: 'Moderate', tone: 'amber' },
      { key: 'low',      label: 'Low',      tone: 'green' }
    ].map((s) => `
      <div class="sev-card sev-${s.tone}">
        <div class="sev-count">${sevTallies[s.key]}</div>
        <div class="sev-label">${s.label}</div>
      </div>
    `).join('');

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
      background: #FFFFFF;
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
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #4A5568;
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
      font-size: 10px;
      background: #FFFFFF;
      border-radius: 8px;
      overflow: hidden;
    }
    /* Keep register rows from splitting across pages — puppeteer otherwise
       breaks mid-row and shows the bottom edge as a stray line. */
    tr, td, th { page-break-inside: avoid; }
    thead { display: table-header-group; }
    th {
      background-color: #EDF2F7;
      padding: 8px;
      text-align: left;
      font-weight: 600;
      color: #2D3748;
      border: 1px solid #CBD5E0;
      font-size: 10px;
    }
    td {
      padding: 7px;
      border: 1px solid #E2E8F0;
      color: #4A5568;
      background: white;
      font-size: 10px;
    }
    tr:nth-child(even) td { background-color: #F7FAFC; }
    .no-data {
      color: #718096;
      font-size: 10px;
      padding: 12px;
      text-align: center;
      font-style: italic;
      background: rgba(255,255,255,0.9);
      border-radius: 8px;
      margin-top: 12px;
    }
    .footer {
      margin-top: 30px;
      padding: 15px 0;
      border-top: 2px solid #E2E8F0;
      text-align: center;
      color: #718096;
      font-size: 9px;
      line-height: 1.8;
    }
    .footer p { margin: 4px 0; }

    /* ---- Heat map + severity overview ---- */
    .section-title {
      font-family: 'Poppins', sans-serif;
      color: #132E5E;
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .section-sub {
      color: #64748B;
      font-size: 11px;
      margin-bottom: 14px;
    }
    .panel {
      background: rgba(255,255,255,0.92);
      border: 1px solid #E2E8F0;
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 22px;
      page-break-inside: avoid;
    }
    .sev-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0,1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .sev-card {
      padding: 14px 12px;
      border-radius: 10px;
      border: 1px solid transparent;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sev-red    { background: #FEE2E2; color: #991B1B; border-color: #FECACA; }
    .sev-amber  { background: #FEF3C7; color: #92400E; border-color: #FDE68A; }
    .sev-green  { background: #DCFCE7; color: #166534; border-color: #BBF7D0; }
    .sev-count {
      font-size: 22px;
      font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .sev-label {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .heat-wrap {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      justify-content: flex-start;
    }
    .heat-grid {
      flex: 0 0 auto;
    }
    .heat-table {
      border-collapse: separate;
      border-spacing: 4px;
      table-layout: fixed;
      /* Width = axis column (32) + 5 cells × 60 + 6 spacings × 4. */
      width: ${32 + 5 * 60 + 6 * 4}px;
    }
    .heat-table th, .heat-table td {
      background: transparent;
      border: 0;
      padding: 0;
      font-size: 10px;
    }
    .heat-axis-y {
      width: 32px;
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      color: #64748B;
      vertical-align: middle;
    }
    .heat-axis-x-row td {
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      color: #64748B;
      padding-top: 6px !important;
    }
    .heat-cell {
      width: 60px;
      height: 60px;
      border-radius: 8px;
      vertical-align: middle;
      text-align: center;
    }
    .heat-count {
      font-size: 16px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }
    .heat-score {
      font-size: 8px;
      font-weight: 600;
      opacity: 0.65;
      letter-spacing: 0.04em;
      margin-top: 2px;
    }
    .axis-label-x {
      text-align: center;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748B;
      margin-top: 6px;
    }
    .axis-label-y {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748B;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
    }
    .heat-legend {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 130px;
      padding-top: 4px;
    }
    .heat-legend-title {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748B;
      margin-bottom: 2px;
    }
    .heat-legend-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: #475569;
    }
    .heat-legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      flex-shrink: 0;
      border: 1px solid rgba(0,0,0,0.05);
    }
    .register-section { page-break-before: auto; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${logoSrc ? `<img src=${JSON.stringify(logoSrc)} alt="Logo" class="logo" />` : ''}
      <h1>Risk Register</h1>
      <p class="subtitle">${esc(org?.name || '')}</p>
    </div>

    <!-- Heat map + severity overview — printed first per the brief. -->
    <div class="panel">
      <div class="section-title">Risk Heat Map</div>
      <div class="section-sub">Distribution of risks across consequence × likelihood. Cell colour reflects the resulting score.</div>

      <div class="sev-grid">
        ${sevCardsHtml}
      </div>

      <div class="heat-wrap">
        <div class="axis-label-y">More consequence ↑</div>
        <div class="heat-grid">
          <table class="heat-table">
            <tbody>
              ${heatRowsHtml}
              <tr class="heat-axis-x-row">
                <td></td>
                ${[1, 2, 3, 4, 5].map((n) => `<td>${n}</td>`).join('')}
              </tr>
            </tbody>
          </table>
          <div class="axis-label-x">Likelihood →</div>
        </div>
        <div class="heat-legend">
          <div class="heat-legend-title">Score band</div>
          <div class="heat-legend-row"><span class="heat-legend-dot" style="background:#DCFCE7"></span>1–4 · Low</div>
          <div class="heat-legend-row"><span class="heat-legend-dot" style="background:#ECFCCB"></span>5–8 · Minor</div>
          <div class="heat-legend-row"><span class="heat-legend-dot" style="background:#FEF3C7"></span>9–12 · Moderate</div>
          <div class="heat-legend-row"><span class="heat-legend-dot" style="background:#FFEDD5"></span>13–16 · High</div>
          <div class="heat-legend-row"><span class="heat-legend-dot" style="background:#FEE2E2"></span>17–20 · Severe</div>
          <div class="heat-legend-row"><span class="heat-legend-dot" style="background:#FCA5A5"></span>21–25 · Critical</div>
        </div>
      </div>
    </div>

    <div class="register-section">
      <div class="section-title">Risk Register</div>
      <div class="section-sub">${risks.length} risk${risks.length === 1 ? '' : 's'} on the register.</div>
    </div>

    ${risks.length === 0 ? `
      <p class="no-data">No risks found in the register.</p>
    ` : `
      <table>
        <thead>
          <tr>
            <th style="width:6%;">#</th>
            <th style="width:28%;">Title</th>
            <th style="width:18%;">Category</th>
            <th style="width:18%;">Department</th>
            <th style="width:10%;">Status</th>
            <th style="width:10%;">Inherent</th>
            <th style="width:10%;">Residual</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    `}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())}</p>
      <p>Charity Compliance Management System | Confidential Document</p>
    </div>
  </div>
</body>
</html>
    `;

    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 0 });
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

