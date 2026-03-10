/**
 * Training PDF Generation Service
 * Matches the visual style of policy/approval PDFs (Poppins/Inter, gradient background, tables).
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

const formatDateTime = (value) => {
  if (!value) return '—';
  try {
    const d = new Date(value);
    return `${formatDate(d)} ${d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
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

const normalizeUrl = (raw) => {
  const url = (raw || '').trim();
  if (!url) return '';
  if (/^(https?:)?\/\//i.test(url)) return url;
  // If it already looks like a domain/path but no protocol, prefix https://
  return `https://${url.replace(/^\/+/, '')}`;
};

export const generateTrainingProgramPDF = async (report, logoUrl) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const { program, modules = [], enrollments = [] } = report || {};

    const title = program?.title || program?.category || 'Training Program';
    const category = program?.category || 'Training';
    const status = (program?.status || 'active').replace(/_/g, ' ');
    const expires = program?.expires ? 'Yes' : 'No';

    const totalModules = modules.length;
    const totalResources = modules.reduce((sum, m) => sum + ((m.resources || []).length || 0), 0);

    const resourcesHTML = modules.map((mod) => {
      const resRows = (mod.resources || []).map((res, idx) => {
        const type = (res.type || '').toLowerCase();
        const rawUrl = type === 'link' ? (res.link_url || '') : '';
        const url = normalizeUrl(rawUrl);
        return `
          <tr>
            <td>${idx + 1}</td>
            <td>${esc(res.name || 'Resource')}</td>
            <td>${type || 'resource'}</td>
            <td>${res.estimated_minutes != null ? `${res.estimated_minutes} min` : '—'}</td>
            <td>${url ? `<a href="${esc(url)}" target="_blank">${esc(res.name || 'Open resource')}</a>` : '—'}</td>
          </tr>
        `;
      }).join('');

      return `
        <h2>Module: ${esc(mod.title || mod.name || 'Module')}</h2>
        ${(mod.description || '').trim() ? `<p style="margin-bottom:8px;font-size:11px;color:#4A5568;">${esc(mod.description)}</p>` : ''}
        ${(mod.resources || []).length === 0 ? '<p class="no-data">No resources added to this module.</p>' : `
        <table>
          <thead>
            <tr>
              <th style="width:5%;">#</th>
              <th style="width:35%;">Resource</th>
              <th style="width:15%;">Type</th>
              <th style="width:15%;">Duration</th>
              <th style="width:30%;">Link</th>
            </tr>
          </thead>
          <tbody>${resRows}</tbody>
        </table>`}
      `;
    }).join('');

    const enrollmentsHTML = enrollments.length === 0 ? '<p class="no-data">No participants have been enrolled yet.</p>' : `
      <table>
        <thead>
          <tr>
            <th style="width:20%;">Participant</th>
            <th style="width:15%;">Position</th>
            <th style="width:15%;">Overall Status</th>
            <th style="width:50%;">Resource Completions & E-signatures</th>
          </tr>
        </thead>
        <tbody>
          ${enrollments.map((enr) => {
            const name = enr.person?.name || '—';
            const pos = enr.person?.position || '—';
            const overallStatus = enr.status || 'assigned';
            const compLines = (enr.completions || []).map((c) => {
              const resName = c.resource?.name || 'Resource';
              const type = (c.resource?.type || '').toLowerCase();
              const status = c.status || 'not_started';
              const hasSig = !!c.signature_data;
              return `${esc(resName)} (${type || 'resource'}) — ${status}${hasSig ? ' (signed)' : ''}`;
            }).join('<br/>');

            return `
              <tr>
                <td>${esc(name)}</td>
                <td>${esc(pos)}</td>
                <td>${esc(overallStatus)}</td>
                <td style="font-size:10px;">${compLines || '—'}</td>
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
      <h1>Training Program Report</h1>
      <p class="subtitle">${esc(title)} — ${esc(category)}</p>
    </div>

    <h2>Program Details</h2>
    <table class="info-table">
      <tr><td>Title</td><td>${esc(title)}</td></tr>
      <tr><td>Category</td><td>${esc(category)}</td></tr>
      <tr><td>Status</td><td>${esc(status)}</td></tr>
      <tr><td>Expires</td><td>${expires}</td></tr>
      <tr><td>Total Modules</td><td>${totalModules}</td></tr>
      <tr><td>Total Resources</td><td>${totalResources}</td></tr>
    </table>

    ${resourcesHTML || '<p class="no-data">No modules or resources defined for this training program.</p>'}

    <h2>Participants & Completions (${enrollments.length})</h2>
    ${enrollmentsHTML}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())} at ${new Date().toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'})}</p>
      <p>This training report summarises resources, participants, and completion status (including e-signatures where captured).</p>
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

export const generateTrainingMemberPDF = async (report, logoUrl) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const { program, person, modules = [], completions = [], survey } = report || {};

    const title = program?.title || program?.category || 'Training Program';
    const personName = person?.name || 'Member';
    const personRole = person?.position || '';

    const resourcesHTML = modules.map((mod) => {
      const resRows = (mod.resources || []).map((res, idx) => {
        const type = (res.type || '').toLowerCase();
        const comp = completions.find((c) => {
          const compResId = c.resource_id?._id || c.resource_id;
          return compResId && String(compResId) === String(res._id);
        });
        const status = comp?.status || 'not_started';
        const hasSig = !!comp?.signature_data;
        const rawUrl = res.link_url || res.file_url || '';
        const url = normalizeUrl(rawUrl);
        const linkLabel = res.name || (type === 'pdf' ? 'View PDF' : 'Open resource');
        const signatureCell = hasSig && typeof comp.signature_data === 'string' && comp.signature_data.startsWith('data:')
          ? `<img src="${comp.signature_data}" class="signature-img" alt="Signature" />`
          : (hasSig ? 'Signed' : 'No');
        return `
          <tr>
            <td>${idx + 1}</td>
            <td>${esc(res.name || 'Resource')}</td>
            <td>${type || 'resource'}</td>
            <td>${status}</td>
            <td style="text-align:center;">${signatureCell}</td>
            <td>${url ? `<a href="${esc(url)}" target="_blank">${esc(linkLabel)}</a>` : '—'}</td>
          </tr>
        `;
      }).join('');

      return `
        <h2>Module: ${esc(mod.title || mod.name || 'Module')}</h2>
        ${(mod.description || '').trim() ? `<p style="margin-bottom:8px;font-size:11px;color:#4A5568;">${esc(mod.description)}</p>` : ''}
        ${(mod.resources || []).length === 0 ? '<p class="no-data">No resources added to this module.</p>' : `
        <table>
          <thead>
            <tr>
              <th style="width:5%;">#</th>
              <th style="width:30%;">Resource</th>
              <th style="width:15%;">Type</th>
              <th style="width:15%;">Status</th>
              <th style="width:10%;">Signed</th>
              <th style="width:25%;">Link</th>
            </tr>
          </thead>
          <tbody>${resRows}</tbody>
        </table>`}
      `;
    }).join('');

    let surveyHTML = '';
    if (survey && survey.completed_at) {
      const rating = typeof survey.rating === 'number' ? `${survey.rating}/5` : '—';
      const clarity = survey.clarity ? survey.clarity.replace(/_/g, ' ') : '—';
      const relevance = survey.relevance ? survey.relevance.replace(/_/g, ' ') : '—';
      const comments = survey.comments ? esc(survey.comments) : '—';
      surveyHTML = `
        <h2>Post-training Survey</h2>
        <table class="info-table">
          <tr><td>Overall rating</td><td>${rating}</td></tr>
          <tr><td>Clarity</td><td>${esc(clarity)}</td></tr>
          <tr><td>Relevance</td><td>${esc(relevance)}</td></tr>
          <tr><td>Comments</td><td>${comments}</td></tr>
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
    .signature-img {
      max-width: 150px;
      max-height: 60px;
      display: block;
      margin: 0 auto;
      border: 1px solid #E2E8F0;
      padding: 4px;
      background: white;
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
      <h1>Training Completion Report</h1>
      <p class="subtitle">${esc(title)}</p>
    </div>

    <h2>Participant Details</h2>
    <table class="info-table">
      <tr><td>Name</td><td>${esc(personName)}</td></tr>
      <tr><td>Position</td><td>${esc(personRole || '—')}</td></tr>
    </table>

    ${resourcesHTML || '<p class="no-data">No resources defined for this training program.</p>'}

    ${surveyHTML}

    <div class="footer">
      <p><strong>Generated on:</strong> ${formatDate(new Date())} at ${new Date().toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'})}</p>
      <p>This training completion report shows all assigned resources, completion status and e-signatures where captured.</p>
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

