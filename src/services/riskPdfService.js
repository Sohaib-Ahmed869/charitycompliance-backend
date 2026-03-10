/**
 * Risk PDF Generation Service
 * Mirrors the visual style of policy / training PDFs.
 */

import puppeteer from 'puppeteer';

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

export const generateRiskDetailPDF = async (payload, logoUrl) => {
  const browser = await puppeteer.launch({
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
      ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="logo" />` : ''}
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
    await browser.close();
    return pdfBuffer;
  } catch (error) {
    await browser.close();
    throw error;
  }
};

export const generateRiskRegisterPDF = async (payload, logoUrl) => {
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
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
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
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="logo" />` : ''}
      <h1>Risk Register</h1>
      <p class="subtitle">${esc(org?.name || '')}</p>
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

