/**
 * ACNC reporting PDF generation (AIS + Annual Financial Report v1)
 * Uses Puppeteer; shares styling with other PDF services.
 */

import puppeteer from 'puppeteer';
import { resolveLogoSrcForPdf } from '../utils/pdfLogo.js';

const esc = (str) =>
  String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtMoney = (n) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n || 0));

function humanize(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Not specified';
  const map = {
    status_not_paid: 'Status is not paid',
    amount_not_positive: 'Amount is not positive',
    missing_paid_date: 'Missing paid date',
    missing_date: 'Missing date',
    outside_fy: 'Outside reporting period',
    not_completed_or_deposited: 'Not completed or deposit-confirmed',
    awaiting_second_counter_ack: 'Awaiting second counter acknowledgement',
    awaiting_office_ack: 'Awaiting office acknowledgement',
  };
  if (map[raw]) return map[raw];
  return raw
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

// ── ACNC label maps (mirror frontend constants) ──────────────────────────────
const ENTITY_SUBTYPE_LABELS = {
  pbi: 'Public Benevolent Institution (PBI)',
  hpc: 'Health Promotion Charity (HPC)',
  religious: 'Religious Institution',
  public_education: 'Public Educational Institution',
  animal_welfare: 'Institution for animal welfare',
  culture: 'Institution for advancement of culture',
  environment: 'Institution for advancement of natural environment',
  charity_fund: 'Charity fund (e.g. DGR-endorsed fund)',
  other: 'Other / Not applicable'
};
const CHARITABLE_PURPOSE_LABELS = {
  health: 'Advancing health',
  education: 'Advancing education',
  social_welfare: 'Advancing social or public welfare',
  religion: 'Advancing religion',
  culture: 'Advancing culture',
  reconciliation: 'Promoting reconciliation, mutual respect and tolerance',
  human_rights: 'Promoting or protecting human rights',
  security: 'Advancing security or safety of Australia / Australian public',
  animal_welfare: 'Preventing or relieving the suffering of animals',
  environment: 'Advancing the natural environment',
  other_beneficial: 'Other purpose beneficial to the general public',
  law_change: 'Promoting or opposing a change in law or government policy (furthering above)'
};
const AU_STATE_LABELS = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland',
  WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania',
  ACT: 'Australian Capital Territory', NT: 'Northern Territory'
};
const ORG_TYPE_LABELS = {
  company_limited_by_guarantee: 'Company limited by guarantee',
  incorporated_association: 'Incorporated association',
  trust: 'Trust',
  unincorporated_association: 'Unincorporated association',
  other: 'Other'
};
const DGR_LABELS = {
  endorsed: 'Endorsed',
  not_endorsed: 'Not endorsed',
  pending: 'Pending',
  applying: 'Applying'
};
const SIZE_BAND_LABELS = {
  '1-10': '1–10 staff',
  '11-50': '11–50 staff',
  '51-200': '51–200 staff',
  '201-500': '201–500 staff',
  '500+': '500+ staff'
};

function fmtDate(d) {
  if (!d) return '—';
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

function rowsToTable(rows, cols) {
  if (!rows || rows.length === 0) return '<p class="no-data">No data available.</p>';
  const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r) => {
      const tds = cols
        .map((c) => `<td>${esc(typeof c.get === 'function' ? c.get(r) : r?.[c.key])}</td>`)
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function buildAppendix(prefill) {
  const fin = prefill?.financials || {};
  const b = fin?.breakdown || {};
  const includedDon = b.included_donations || [];
  const excludedDon = b.excluded_donations || [];
  const includedBox = b.included_donation_box_entries || [];
  const excludedBox = b.excluded_donation_box_entries || [];
  const includedExp = b.included_expenses || [];
  const excludedExp = b.excluded_expenses || [];

  const excludedExpenseByStatus = b.excluded_expenses_by_status || {};
  const excludedExpenseStatusRows = Object.entries(excludedExpenseByStatus || {})
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => ({ status, count }));

  const excludedDonationReasonRows = Object.entries(b.excluded_donations_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
  const excludedBoxReasonRows = Object.entries(b.excluded_donation_box_entries_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
  const excludedExpenseReasonRows = Object.entries(b.excluded_expenses_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  return `
    <h2>Appendix: Calculation rules and reconciliation</h2>
    <div class="callout">
      <div><strong>Revenue rule:</strong> ${esc(fin?.rules?.revenue || '')}</div>
      <div style="margin-top:6px;"><strong>Expenses rule:</strong> ${esc(fin?.rules?.expenses || '')}</div>
    </div>

    <h3>Included totals</h3>
    <table class="info-table">
      <tr><td>Donations included</td><td>${includedDon.length} (${esc(fmtMoney(fin?.donations))})</td></tr>
      <tr><td>Donation box entries included</td><td>${includedBox.length} (${esc(fmtMoney(fin?.donation_boxes))})</td></tr>
      <tr><td>Paid expenses included</td><td>${includedExp.length} (${esc(fmtMoney(fin?.expenses))})</td></tr>
    </table>

    <h3>Excluded counts (why totals may differ)</h3>
    <h4>Donations excluded reasons</h4>
    ${rowsToTable(excludedDonationReasonRows, [
      { label: 'Reason', get: (r) => humanize(r.reason) },
      { label: 'Count', get: (r) => String(r.count) }
    ])}

    <h4>Donation box entries excluded reasons</h4>
    ${rowsToTable(excludedBoxReasonRows, [
      { label: 'Reason', get: (r) => humanize(r.reason) },
      { label: 'Count', get: (r) => String(r.count) }
    ])}

    <h4>Expenses excluded by status</h4>
    ${rowsToTable(excludedExpenseStatusRows, [
      { label: 'Expense status', get: (r) => humanize(r.status) },
      { label: 'Count', get: (r) => String(r.count) }
    ])}

    <h4>Expenses excluded reasons</h4>
    ${rowsToTable(excludedExpenseReasonRows, [
      { label: 'Reason', get: (r) => humanize(r.reason) },
      { label: 'Count', get: (r) => String(r.count) }
    ])}

    <h3>Sample excluded items (first 20 each)</h3>
    <h4>Donations excluded</h4>
    ${rowsToTable(excludedDon.slice(0, 20), [
      { label: 'Title', key: 'title' },
      { label: 'Amount', get: (r) => fmtMoney(r.amount) },
      { label: 'Date', key: 'date' },
      { label: 'Status', get: (r) => humanize(r.status) },
    ])}

    <h4>Donation box entries excluded</h4>
    ${rowsToTable(excludedBox.slice(0, 20), [
      { label: 'Box', key: 'box_name' },
      { label: 'Amount', get: (r) => fmtMoney(r.amount) },
      { label: 'Date', key: 'date' },
      { label: 'Workflow', get: (r) => humanize(r.workflow_status) },
    ])}

    <h4>Expenses excluded</h4>
    ${rowsToTable(excludedExp.slice(0, 20), [
      { label: 'Title', key: 'title' },
      { label: 'Amount', get: (r) => fmtMoney(r.amount) },
      { label: 'Date', key: 'date' },
      { label: 'Status', get: (r) => humanize(r.status) },
    ])}
  `;
}

function buildBaseHtml({ title, subtitle, logoSrc, bodyHtml }) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
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
    td { font-size: 10px; padding: 7px; border: 1px solid #111; vertical-align: top; }
    .info-table td:first-child { font-weight: 600; width: 30%; }
    .no-data { color: #374151; font-size: 10px; padding: 10px; border: 1px solid #111; }
    .callout { border: 1px solid #111; background: #fff; padding: 10px; font-size: 10px; color: #111; line-height: 1.6; }
    .footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #111; font-size: 9px; color: #111; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-top">
        ${logoSrc ? `<img class="logo" src=${JSON.stringify(logoSrc)} alt="Logo" />` : ''}
        <div>
          <h1>${esc(title)}</h1>
          <div class="subtitle">${esc(subtitle)}</div>
        </div>
      </div>
    </div>
    ${bodyHtml}
    <div class="footer">
      Generated on ${esc(fmtDate(new Date()))}. Confidential internal report export.
    </div>
  </div>
</body>
</html>
  `;
}

async function generatePdfFromHtml(html, { timeoutMs = 120000 } = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18px', right: '18px', bottom: '18px', left: '18px' }
    });
    await browser.close();
    return pdfBuffer;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

export async function generateAisPdf({ prefill, overrides }) {
  const charity = prefill?.charity || {};
  const fin = prefill?.financials || {};
  const fy = prefill?.fy || {};
  const logoSrc = await resolveLogoSrcForPdf(charity.logo_url);

  const declName = esc(overrides?.declaration_name || '');
  const declPos = esc(overrides?.declaration_position || '');
  const declDate = esc(overrides?.declaration_date || '');

  const programs = prefill?.programs || [];
  const rps = prefill?.responsible_people || [];
  const acnc = prefill?.acnc || {};
  const incorp = charity?.incorporation || {};
  const dgr = charity?.dgr || {};

  const subtypeList = (acnc.entity_subtypes || []).map((v) => ENTITY_SUBTYPE_LABELS[v] || humanize(v));
  const purposeList = (acnc.charitable_purposes || []).map((v) => CHARITABLE_PURPOSE_LABELS[v] || humanize(v));
  const stateList = (acnc.operating_states || []).map((c) => `${c} (${AU_STATE_LABELS[c] || c})`);
  const operatingList = Array.isArray(charity.operating_locations) ? charity.operating_locations : [];

  const listOrDash = (arr) => (arr && arr.length ? arr.map((x) => `• ${esc(x)}`).join('<br/>') : '—');

  const body = `
    <h2>Information about your charity</h2>
    <table class="info-table">
      <tr><td>Charity name</td><td>${esc(charity.name)}</td></tr>
      ${charity.trading_name ? `<tr><td>Trading name</td><td>${esc(charity.trading_name)}</td></tr>` : ''}
      ${(charity.former_names || []).length ? `<tr><td>Former names</td><td>${esc(charity.former_names.join(', '))}</td></tr>` : ''}
      <tr><td>ABN</td><td>${esc(charity.abn)}</td></tr>
      ${charity.acn ? `<tr><td>ACN</td><td>${esc(charity.acn)}</td></tr>` : ''}
      ${charity.acnc_registration_number ? `<tr><td>ACNC registration no.</td><td>${esc(charity.acnc_registration_number)}</td></tr>` : ''}
      ${charity.registration_number ? `<tr><td>Registration no.</td><td>${esc(charity.registration_number)}</td></tr>` : ''}
      <tr><td>Website</td><td>${esc(charity.website)}</td></tr>
      <tr><td>Contact email</td><td>${esc(charity.email)}</td></tr>
      <tr><td>Address</td><td>${esc(charity.address)}</td></tr>
      ${charity.establishment_date ? `<tr><td>Established</td><td>${esc(charity.establishment_date)}</td></tr>` : ''}
      ${charity.size_band ? `<tr><td>Staff size</td><td>${esc(SIZE_BAND_LABELS[charity.size_band] || charity.size_band)}</td></tr>` : ''}
      ${charity.works_with_atsi ? `<tr><td>Community focus</td><td>Works with Aboriginal and Torres Strait Islander communities</td></tr>` : ''}
      <tr><td>Reporting period</td><td>${esc(fy.start_date)} to ${esc(fy.end_date)} (FY ending 30 June ${esc(fy.end_year)})</td></tr>
    </table>

    ${(incorp.org_type || incorp.state || incorp.number || dgr.status || dgr.item_number) ? `
    <h2>Registrations &amp; incorporation</h2>
    <table class="info-table">
      ${incorp.org_type ? `<tr><td>Legal structure</td><td>${esc(ORG_TYPE_LABELS[incorp.org_type] || humanize(incorp.org_type))}</td></tr>` : ''}
      ${incorp.state ? `<tr><td>Incorporation state</td><td>${esc(incorp.state)} (${esc(AU_STATE_LABELS[incorp.state] || '')})</td></tr>` : ''}
      ${incorp.number ? `<tr><td>Incorporation no.</td><td>${esc(incorp.number)}</td></tr>` : ''}
      ${dgr.status ? `<tr><td>DGR status</td><td>${esc(DGR_LABELS[dgr.status] || humanize(dgr.status))}</td></tr>` : ''}
      ${dgr.item_number ? `<tr><td>DGR item no.</td><td>${esc(dgr.item_number)}</td></tr>` : ''}
      ${dgr.endorsement_date ? `<tr><td>DGR endorsement date</td><td>${esc(dgr.endorsement_date)}</td></tr>` : ''}
    </table>
    ` : ''}

    <h2>ACNC classification</h2>
    <table class="info-table">
      <tr><td>Main charitable activity</td><td>${esc(acnc.main_activity) || '—'}</td></tr>
      <tr><td>Entity subtype(s)</td><td>${listOrDash(subtypeList)}</td></tr>
      <tr><td>Charitable purposes</td><td>${listOrDash(purposeList)}</td></tr>
    </table>

    <h2>Operating locations</h2>
    <table class="info-table">
      <tr><td>Australian states &amp; territories</td><td>${listOrDash(stateList)}</td></tr>
      <tr><td>Countries operated in</td><td>${listOrDash(operatingList)}</td></tr>
    </table>

    <h2>Programs / activities</h2>
    ${rowsToTable(programs, [
      { label: 'Program name', key: 'name' },
      { label: 'Description', key: 'description' },
      { label: 'Beneficiaries', key: 'beneficiaries' },
      { label: 'Locations', get: (r) => (Array.isArray(r.locations) ? r.locations.join(', ') : '') },
      { label: 'Website', key: 'website_url' },
    ])}

    <h2>Responsible people</h2>
    ${rowsToTable(rps, [
      { label: 'Name', key: 'name' },
      { label: 'Position', key: 'position' },
      { label: 'Email', key: 'email' },
      { label: 'Director ID', key: 'director_id' },
      { label: 'Start', key: 'start_date' },
      { label: 'End', key: 'end_date' },
    ])}

    <h2>Financial information (system-derived, cash basis)</h2>
    <table class="info-table">
      <tr><td>Total revenue</td><td>${esc(fmtMoney(fin.revenue))}</td></tr>
      <tr><td>&nbsp;&nbsp;↳ Donations</td><td>${esc(fmtMoney(fin.donations))}</td></tr>
      <tr><td>&nbsp;&nbsp;↳ Donation boxes</td><td>${esc(fmtMoney(fin.donation_boxes))}</td></tr>
      <tr><td>Total expenses (paid)</td><td>${esc(fmtMoney(fin.expenses))}</td></tr>
      <tr><td>Net position</td><td>${esc(fmtMoney(fin.net))}</td></tr>
    </table>

    <h2>Declaration</h2>
    <table class="info-table">
      <tr><td>Authorised person</td><td>${declName || '—'}</td></tr>
      <tr><td>Position</td><td>${declPos || '—'}</td></tr>
      <tr><td>Date</td><td>${declDate || '—'}</td></tr>
      <tr><td>Declaration</td><td>I certify the information in this report is true and correct to the best of my knowledge.</td></tr>
    </table>

    ${buildAppendix(prefill)}
  `;

  const html = buildBaseHtml({
    title: 'Annual Information Statement (AIS) Report',
    subtitle: `${charity.name || 'Charity'} — FY ending 30 June ${fy.end_year || ''}`,
    logoSrc,
    bodyHtml: body
  });
  return generatePdfFromHtml(html);
}

export async function generateAcncFinancialPdf({ prefill, overrides }) {
  const charity = prefill?.charity || {};
  const fin = prefill?.financials || {};
  const fy = prefill?.fy || {};
  const logoSrc = await resolveLogoSrcForPdf(charity.logo_url);

  const reportTitle = overrides?.report_title || 'ACNC Annual Financial Report';
  const preparedBy = `${overrides?.prepared_by_name || ''}${overrides?.prepared_by_position ? ` (${overrides.prepared_by_position})` : ''}`.trim();
  const preparedDate = overrides?.prepared_date || '';

  const body = `
    <h2>Report header</h2>
    <table class="info-table">
      <tr><td>Report title</td><td>${esc(reportTitle)}</td></tr>
      <tr><td>Reporting period</td><td>${esc(fy.start_date)} to ${esc(fy.end_date)} (FY ending 30 June ${esc(fy.end_year)})</td></tr>
      <tr><td>Prepared by</td><td>${esc(preparedBy) || '—'}</td></tr>
      <tr><td>Prepared date</td><td>${esc(preparedDate) || '—'}</td></tr>
    </table>

    <h2>Organization</h2>
    <table class="info-table">
      <tr><td>Charity name</td><td>${esc(charity.name)}</td></tr>
      ${charity.trading_name ? `<tr><td>Trading name</td><td>${esc(charity.trading_name)}</td></tr>` : ''}
      <tr><td>ABN</td><td>${esc(charity.abn)}</td></tr>
      ${charity.acn ? `<tr><td>ACN</td><td>${esc(charity.acn)}</td></tr>` : ''}
      ${charity.acnc_registration_number ? `<tr><td>ACNC registration no.</td><td>${esc(charity.acnc_registration_number)}</td></tr>` : ''}
      <tr><td>Website</td><td>${esc(charity.website)}</td></tr>
      <tr><td>Address</td><td>${esc(charity.address)}</td></tr>
      ${charity?.incorporation?.org_type ? `<tr><td>Legal structure</td><td>${esc(ORG_TYPE_LABELS[charity.incorporation.org_type] || humanize(charity.incorporation.org_type))}</td></tr>` : ''}
      ${charity?.dgr?.status ? `<tr><td>DGR status</td><td>${esc(DGR_LABELS[charity.dgr.status] || humanize(charity.dgr.status))}${charity.dgr.item_number ? ` · item ${esc(charity.dgr.item_number)}` : ''}</td></tr>` : ''}
    </table>

    <table class="info-table">
      <tr><td>Total revenue</td><td>${esc(fmtMoney(fin.revenue))}</td></tr>
      <tr><td>Total expenses</td><td>${esc(fmtMoney(fin.expenses))}</td></tr>
      <tr><td>Net position</td><td>${esc(fmtMoney(fin.net))}</td></tr>
      <tr><td>Donations</td><td>${esc(fmtMoney(fin.donations))}</td></tr>
      <tr><td>Donation boxes</td><td>${esc(fmtMoney(fin.donation_boxes))}</td></tr>
      <tr><td>Paid expenses</td><td>${esc(fmtMoney(fin.expenses))}</td></tr>
    </table>

    ${buildAppendix(prefill)}
  `;

  const html = buildBaseHtml({
    title: reportTitle,
    subtitle: `${charity.name || 'Charity'} — FY ending 30 June ${fy.end_year || ''}`,
    logoSrc,
    bodyHtml: body
  });
  return generatePdfFromHtml(html);
}

