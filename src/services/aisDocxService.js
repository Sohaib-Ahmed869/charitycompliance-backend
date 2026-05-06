/**
 * AIS DOCX (Word) generator.
 *
 * Phase 1 of the editable AIS export — produces a Word document so users can
 * layer in figures Stewardex doesn't hold (e.g. revenue streams from their
 * accounting software) before lodging.
 *
 * The DOCX format is an OOXML zip — we hand-write the minimum file set
 * (Content_Types, package rels, document.xml, document rels, styles, settings)
 * and stream them through `archiver` (already a project dep). No new npm
 * packages required.
 */

import archiver from 'archiver';

// ---------- helpers ----------

const xmlEscape = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  }[c]));

const fmtMoney = (n) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n || 0));

// ── Label maps mirror the PDF service so the DOCX reads like the PDF
//    (humanised values, not raw enum codes). ────────────────────────────────
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

function humanize(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const map = {
    status_not_paid: 'Status is not paid',
    amount_not_positive: 'Amount is not positive',
    missing_paid_date: 'Missing paid date',
    missing_date: 'Missing date',
    outside_fy: 'Outside reporting period',
    not_completed_or_deposited: 'Not completed or deposit-confirmed',
    awaiting_second_counter_ack: 'Awaiting second counter acknowledgement',
    awaiting_office_ack: 'Awaiting office acknowledgement'
  };
  if (map[raw]) return map[raw];
  return raw.replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Build a `<w:p>` paragraph with optional style id and run-level attributes.
 * `runs` is an array of `{ text, bold, italic, color, size }`.
 * If a single string is passed it becomes a single plain run.
 */
function pPara(runs, opts = {}) {
  const items = Array.isArray(runs) ? runs : [{ text: runs }];
  const styleXml = opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '';
  const alignXml = opts.align ? `<w:jc w:val="${opts.align}"/>` : '';
  const spacingXml = opts.spacing
    ? `<w:spacing w:before="${opts.spacing.before || 0}" w:after="${opts.spacing.after || 0}"/>`
    : '';
  const pPr = (styleXml || alignXml || spacingXml)
    ? `<w:pPr>${styleXml}${spacingXml}${alignXml}</w:pPr>`
    : '';
  const runsXml = items.map((r) => {
    const rStyle = [];
    if (r.bold) rStyle.push('<w:b/>');
    if (r.italic) rStyle.push('<w:i/>');
    if (r.color) rStyle.push(`<w:color w:val="${r.color}"/>`);
    if (r.size) rStyle.push(`<w:sz w:val="${r.size}"/>`);
    const rPr = rStyle.length ? `<w:rPr>${rStyle.join('')}</w:rPr>` : '';
    const text = xmlEscape(r.text || '');
    // xml:space="preserve" so leading/trailing spaces survive
    return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  }).join('');
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

const heading1 = (text) => pPara([{ text, bold: true, size: 32 }], { style: 'Heading1', spacing: { before: 240, after: 120 } });
const heading2 = (text) => pPara([{ text, bold: true, size: 26 }], { style: 'Heading2', spacing: { before: 200, after: 80 } });
const blank = () => pPara('');
const note = (text) => pPara([{ text, italic: true, color: '6B7280', size: 18 }]);

/**
 * Two-column key/value table, used for charity details / classification etc.
 * `rows` is an array of [label, value] tuples; nullish values render as "—".
 */
function kvTable(rows) {
  const trXml = rows.map(([label, value]) => `
    <w:tr>
      <w:tc>
        <w:tcPr><w:tcW w:w="3200" w:type="dxa"/><w:shd w:fill="F1F5F9" w:val="clear"/></w:tcPr>
        ${pPara([{ text: label, bold: true, size: 20 }])}
      </w:tc>
      <w:tc>
        <w:tcPr><w:tcW w:w="6800" w:type="dxa"/></w:tcPr>
        ${pPara([{ text: value == null || value === '' ? '—' : String(value), size: 20 }])}
      </w:tc>
    </w:tr>`).join('');
  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="10000" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:left w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:right w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/>
          <w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/>
        </w:tblBorders>
      </w:tblPr>
      ${trXml}
    </w:tbl>`;
}

/**
 * Multi-column data table with a header row.
 * `headers` = string[]; `rows` = string[][] (already stringified).
 * If `rows` is empty, renders a single italic "Add rows below…" placeholder
 * row so users can fill in data not held in Stewardex.
 */
function dataTable(headers, rows, { placeholderText = 'Add rows below…' } = {}) {
  const colWidth = Math.floor(10000 / headers.length);
  const headerXml = `
    <w:tr>
      <w:trPr><w:tblHeader/></w:trPr>
      ${headers.map((h) => `
        <w:tc>
          <w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/><w:shd w:fill="0A2E3F" w:val="clear"/></w:tcPr>
          ${pPara([{ text: h, bold: true, size: 18, color: 'FFFFFF' }])}
        </w:tc>
      `).join('')}
    </w:tr>`;
  let bodyXml;
  if (!rows || rows.length === 0) {
    bodyXml = `
      <w:tr>
        <w:tc>
          <w:tcPr><w:tcW w:w="${colWidth * headers.length}" w:type="dxa"/><w:gridSpan w:val="${headers.length}"/></w:tcPr>
          ${pPara([{ text: placeholderText, italic: true, color: '94A3B8', size: 18 }], { align: 'center' })}
        </w:tc>
      </w:tr>`;
  } else {
    bodyXml = rows.map((cols) => `
      <w:tr>
        ${cols.map((c) => `
          <w:tc>
            <w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>
            ${pPara([{ text: c == null ? '' : String(c), size: 18 }])}
          </w:tc>
        `).join('')}
      </w:tr>`).join('');
  }
  // Always append a couple of empty rows so users can extend.
  const extraRows = Array(2).fill(0).map(() => `
    <w:tr>
      ${headers.map(() => `
        <w:tc>
          <w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>
          ${pPara([{ text: ' ', size: 18 }])}
        </w:tc>
      `).join('')}
    </w:tr>`).join('');
  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="10000" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:left w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:right w:val="single" w:sz="4" w:color="CBD5E1"/>
          <w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/>
          <w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/>
        </w:tblBorders>
      </w:tblPr>
      ${headerXml}
      ${bodyXml}
      ${extraRows}
    </w:tbl>`;
}

// ---------- AIS body ----------

function buildAisBody({ prefill = {}, overrides = {} }) {
  const charity = prefill.charity || {};
  const fin = prefill.financials || {};
  const fy = prefill.fy || {};
  const acnc = prefill.acnc || {};
  const incorp = charity.incorporation || {};
  const dgr = charity.dgr || {};
  const programs = prefill.programs || [];
  const rps = prefill.responsible_people || [];

  const declName = overrides.declaration_name || '';
  const declPos = overrides.declaration_position || '';
  const declDate = overrides.declaration_date || '';

  const fyLabel = fy.end_year ? `FY ending 30 June ${fy.end_year}` : '';
  const fyRange = (fy.start_date && fy.end_date) ? `${fy.start_date} to ${fy.end_date}` : '—';

  const sections = [];

  // Title block
  sections.push(pPara([{ text: 'Annual Information Statement (AIS)', bold: true, size: 44 }], { align: 'center', spacing: { before: 0, after: 80 } }));
  sections.push(pPara([{ text: charity.name || 'Charity', size: 24, color: '475569' }], { align: 'center', spacing: { after: 60 } }));
  if (fyLabel) sections.push(pPara([{ text: fyLabel, size: 22, color: '64748B' }], { align: 'center', spacing: { after: 240 } }));

  sections.push(note('This is an editable copy of your AIS. Figures and details that come from Stewardex have been pre-filled — review them, then add information held outside Stewardex (e.g. revenue streams from your accounting software).'));
  sections.push(blank());

  // Charity details
  sections.push(heading1('Information about your charity'));
  const charityRows = [
    ['Charity name', charity.name],
    ['Trading name', charity.trading_name],
    ['Former names', (charity.former_names || []).join(', ')],
    ['ABN', charity.abn],
    ['ACN', charity.acn],
    ['ACNC registration no.', charity.acnc_registration_number],
    ['Registration no.', charity.registration_number],
    ['Website', charity.website],
    ['Contact email', charity.email],
    ['Address', charity.address],
    ['Established', charity.establishment_date],
    ['Staff size', charity.size_band ? (SIZE_BAND_LABELS[charity.size_band] || charity.size_band) : '']
  ];
  // Community focus row — only render when set, mirrors PDF behaviour.
  if (charity.works_with_atsi) {
    charityRows.push(['Community focus', 'Works with Aboriginal and Torres Strait Islander communities']);
  }
  charityRows.push(['Reporting period', `${fyRange}${fyLabel ? ` (${fyLabel})` : ''}`]);
  sections.push(kvTable(charityRows));

  // Registrations & incorporation
  if (incorp.org_type || incorp.state || incorp.number || dgr.status || dgr.item_number) {
    sections.push(heading1('Registrations & incorporation'));
    sections.push(kvTable([
      ['Legal structure', incorp.org_type ? (ORG_TYPE_LABELS[incorp.org_type] || humanize(incorp.org_type)) : ''],
      ['Incorporation state', incorp.state ? `${incorp.state}${AU_STATE_LABELS[incorp.state] ? ` (${AU_STATE_LABELS[incorp.state]})` : ''}` : ''],
      ['Incorporation no.', incorp.number],
      ['DGR status', dgr.status ? (DGR_LABELS[dgr.status] || humanize(dgr.status)) : ''],
      ['DGR item no.', dgr.item_number],
      ['DGR endorsement date', dgr.endorsement_date]
    ]));
  }

  // ACNC classification — humanised list values match the PDF.
  const subtypeList = (acnc.entity_subtypes || []).map((v) => ENTITY_SUBTYPE_LABELS[v] || humanize(v));
  const purposeList = (acnc.charitable_purposes || []).map((v) => CHARITABLE_PURPOSE_LABELS[v] || humanize(v));
  sections.push(heading1('ACNC classification'));
  sections.push(kvTable([
    ['Main charitable activity', acnc.main_activity],
    ['Entity subtype(s)', subtypeList.join(', ')],
    ['Charitable purposes', purposeList.join(', ')]
  ]));

  // Operating locations — render state codes with full names.
  const stateList = (acnc.operating_states || []).map((c) => `${c}${AU_STATE_LABELS[c] ? ` (${AU_STATE_LABELS[c]})` : ''}`);
  sections.push(heading1('Operating locations'));
  sections.push(kvTable([
    ['Australian states & territories', stateList.join(', ')],
    ['Countries operated in', (charity.operating_locations || []).join(', ')]
  ]));

  // Programs
  sections.push(heading1('Programs / activities'));
  sections.push(dataTable(
    ['Program name', 'Description', 'Beneficiaries', 'Locations', 'Website'],
    programs.map((p) => [
      p.name || '',
      p.description || '',
      p.beneficiaries || '',
      Array.isArray(p.locations) ? p.locations.join(', ') : '',
      p.website_url || ''
    ]),
    { placeholderText: 'Add programs below…' }
  ));

  // Responsible people
  sections.push(heading1('Responsible people'));
  sections.push(dataTable(
    ['Name', 'Position', 'Email', 'Director ID', 'Start', 'End'],
    rps.map((r) => [
      r.name || '',
      r.position || '',
      r.email || '',
      r.director_id || '',
      r.start_date || '',
      r.end_date || ''
    ]),
    { placeholderText: 'Add responsible people below…' }
  ));

  // Financial summary — Stewardex-derived rows + room to add accounting data
  sections.push(heading1('Financial information'));
  sections.push(note('System-derived totals (cash basis) are pre-filled below. Add additional revenue streams or expense lines from your accounting software in the rows underneath.'));
  sections.push(dataTable(
    ['Line item', 'Amount (AUD)', 'Source'],
    [
      ['Total revenue', fmtMoney(fin.revenue), 'Stewardex (system-derived)'],
      ['  ↳ Donations', fmtMoney(fin.donations), 'Stewardex'],
      ['  ↳ Donation boxes', fmtMoney(fin.donation_boxes), 'Stewardex'],
      ['Total expenses (paid)', fmtMoney(fin.expenses), 'Stewardex'],
      ['Net position', fmtMoney(fin.net), 'Stewardex (calculated)']
    ],
    { placeholderText: 'Add additional financial lines below…' }
  ));

  // Declaration
  sections.push(heading1('Declaration'));
  sections.push(kvTable([
    ['Authorised person', declName],
    ['Position', declPos],
    ['Date', declDate],
    ['Declaration', 'I certify the information in this report is true and correct to the best of my knowledge.']
  ]));

  // Appendix: same reconciliation tables as the PDF.
  sections.push(...buildReconciliationAppendix({ prefill }));

  return sections.join('\n');
}

// ---------- DOCX assembly ----------

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:before="80" w:after="80" w:line="280" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="0A2E3F"/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="117A8B"/><w:sz w:val="26"/></w:rPr>
  </w:style>
</w:styles>`;

const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:zoom w:percent="100"/>
  <w:defaultTabStop w:val="708"/>
  <w:characterSpacingControl w:val="doNotCompress"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
  </w:compat>
</w:settings>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Stewardex</Application>
</Properties>`;

function coreXml({ title, charityName }) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title || 'Annual Information Statement')}</dc:title>
  <dc:creator>Stewardex</dc:creator>
  <cp:lastModifiedBy>${xmlEscape(charityName || 'Stewardex')}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function documentXml(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>
      <w:cols w:space="708"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

/**
 * Stream the AIS as a DOCX buffer. Pure-JS, no external services.
 */
export async function generateAisDocx({ prefill, overrides }) {
  const bodyXml = buildAisBody({ prefill, overrides });
  return packageDocx({
    bodyXml,
    title: 'Annual Information Statement',
    charityName: prefill?.charity?.name
  });
}

// ── ACNC Annual Financial Report body — mirrors generateAcncFinancialPdf so
//    the editable copy carries the same content the PDF does.
function buildAcncFinancialBody({ prefill = {}, overrides = {} }) {
  const charity = prefill.charity || {};
  const fin = prefill.financials || {};
  const fy = prefill.fy || {};
  const incorp = charity.incorporation || {};
  const dgr = charity.dgr || {};

  const reportTitle = overrides.report_title || 'ACNC Annual Financial Report';
  const preparedBy = `${overrides.prepared_by_name || ''}${overrides.prepared_by_position ? ` (${overrides.prepared_by_position})` : ''}`.trim();
  const preparedDate = overrides.prepared_date || '';

  const fyLabel = fy.end_year ? `FY ending 30 June ${fy.end_year}` : '';
  const fyRange = (fy.start_date && fy.end_date) ? `${fy.start_date} to ${fy.end_date}` : '—';

  const sections = [];

  // Title block
  sections.push(pPara([{ text: reportTitle, bold: true, size: 44 }], { align: 'center', spacing: { before: 0, after: 80 } }));
  sections.push(pPara([{ text: charity.name || 'Charity', size: 24, color: '475569' }], { align: 'center', spacing: { after: 60 } }));
  if (fyLabel) sections.push(pPara([{ text: fyLabel, size: 22, color: '64748B' }], { align: 'center', spacing: { after: 240 } }));

  sections.push(note('Editable copy of your ACNC Annual Financial Report. System-derived figures have been pre-filled — review them and add accounting-software lines (deductions, in-kind, accruals) before lodging.'));
  sections.push(blank());

  // Report header
  sections.push(heading1('Report header'));
  sections.push(kvTable([
    ['Report title', reportTitle],
    ['Reporting period', `${fyRange}${fyLabel ? ` (${fyLabel})` : ''}`],
    ['Prepared by', preparedBy],
    ['Prepared date', preparedDate]
  ]));

  // Organization
  sections.push(heading1('Organisation'));
  sections.push(kvTable([
    ['Charity name', charity.name],
    ['Trading name', charity.trading_name],
    ['ABN', charity.abn],
    ['ACN', charity.acn],
    ['ACNC registration no.', charity.acnc_registration_number],
    ['Website', charity.website],
    ['Address', charity.address],
    ['Legal structure', incorp.org_type ? (ORG_TYPE_LABELS[incorp.org_type] || humanize(incorp.org_type)) : ''],
    ['DGR status', dgr.status
      ? `${DGR_LABELS[dgr.status] || humanize(dgr.status)}${dgr.item_number ? ` · item ${dgr.item_number}` : ''}`
      : '']
  ]));

  // Financial summary — Stewardex-derived rows + room to add extra lines.
  sections.push(heading1('Financial summary'));
  sections.push(note('System-derived totals (cash basis) below. Add additional revenue/expense lines from your accounting software in the empty rows.'));
  sections.push(dataTable(
    ['Line item', 'Amount (AUD)', 'Source'],
    [
      ['Total revenue', fmtMoney(fin.revenue), 'Stewardex (system-derived)'],
      ['  ↳ Donations', fmtMoney(fin.donations), 'Stewardex'],
      ['  ↳ Donation boxes', fmtMoney(fin.donation_boxes), 'Stewardex'],
      ['Total expenses (paid)', fmtMoney(fin.expenses), 'Stewardex'],
      ['Net position', fmtMoney(fin.net), 'Stewardex (calculated)']
    ],
    { placeholderText: 'Add additional financial lines below…' }
  ));

  // Appendix: same reconciliation as the PDF.
  sections.push(...buildReconciliationAppendix({ prefill }));

  return sections.join('\n');
}

/**
 * Shared appendix builder — used by both AIS and ACNC Financial DOCX paths.
 * Returns an array of paragraph/table XML strings the caller can spread into
 * its sections list.
 */
function buildReconciliationAppendix({ prefill }) {
  const fin = prefill?.financials || {};
  const breakdown = fin.breakdown || {};
  const includedDon = breakdown.included_donations || [];
  const excludedDon = breakdown.excluded_donations || [];
  const includedBox = breakdown.included_donation_box_entries || [];
  const excludedBox = breakdown.excluded_donation_box_entries || [];
  const includedExp = breakdown.included_expenses || [];
  const excludedExp = breakdown.excluded_expenses || [];

  const excludedDonationReasonRows = Object.entries(breakdown.excluded_donations_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => [humanize(reason), String(count)]);
  const excludedBoxReasonRows = Object.entries(breakdown.excluded_donation_box_entries_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => [humanize(reason), String(count)]);
  const excludedExpenseStatusRows = Object.entries(breakdown.excluded_expenses_by_status || {})
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => [humanize(status), String(count)]);
  const excludedExpenseReasonRows = Object.entries(breakdown.excluded_expenses_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => [humanize(reason), String(count)]);

  const out = [];
  out.push(heading1('Appendix: Calculation rules and reconciliation'));
  out.push(pPara([{ text: 'Revenue rule: ', bold: true, size: 20 }, { text: fin?.rules?.revenue || '—', size: 20 }]));
  out.push(pPara([{ text: 'Expenses rule: ', bold: true, size: 20 }, { text: fin?.rules?.expenses || '—', size: 20 }]));
  out.push(blank());

  out.push(heading2('Included totals'));
  out.push(kvTable([
    ['Donations included', `${includedDon.length} (${fmtMoney(fin.donations)})`],
    ['Donation box entries included', `${includedBox.length} (${fmtMoney(fin.donation_boxes)})`],
    ['Paid expenses included', `${includedExp.length} (${fmtMoney(fin.expenses)})`]
  ]));

  out.push(heading2('Excluded counts (why totals may differ)'));
  out.push(pPara([{ text: 'Donations excluded — reasons', bold: true, size: 20 }]));
  out.push(dataTable(['Reason', 'Count'], excludedDonationReasonRows, { placeholderText: 'No excluded donations.' }));
  out.push(pPara([{ text: 'Donation box entries excluded — reasons', bold: true, size: 20 }]));
  out.push(dataTable(['Reason', 'Count'], excludedBoxReasonRows, { placeholderText: 'No excluded donation box entries.' }));
  out.push(pPara([{ text: 'Expenses excluded — by status', bold: true, size: 20 }]));
  out.push(dataTable(['Expense status', 'Count'], excludedExpenseStatusRows, { placeholderText: 'No expenses excluded by status.' }));
  out.push(pPara([{ text: 'Expenses excluded — reasons', bold: true, size: 20 }]));
  out.push(dataTable(['Reason', 'Count'], excludedExpenseReasonRows, { placeholderText: 'No excluded expenses.' }));

  out.push(heading2('Sample excluded items (first 20 each)'));
  out.push(pPara([{ text: 'Donations excluded', bold: true, size: 20 }]));
  out.push(dataTable(
    ['Title', 'Amount', 'Date', 'Status'],
    excludedDon.slice(0, 20).map((r) => [r.title || '', fmtMoney(r.amount), r.date || '', humanize(r.status)]),
    { placeholderText: 'No excluded donations.' }
  ));
  out.push(pPara([{ text: 'Donation box entries excluded', bold: true, size: 20 }]));
  out.push(dataTable(
    ['Box', 'Amount', 'Date', 'Workflow'],
    excludedBox.slice(0, 20).map((r) => [r.box_name || '', fmtMoney(r.amount), r.date || '', humanize(r.workflow_status)]),
    { placeholderText: 'No excluded donation box entries.' }
  ));
  out.push(pPara([{ text: 'Expenses excluded', bold: true, size: 20 }]));
  out.push(dataTable(
    ['Title', 'Amount', 'Date', 'Status'],
    excludedExp.slice(0, 20).map((r) => [r.title || '', fmtMoney(r.amount), r.date || '', humanize(r.status)]),
    { placeholderText: 'No excluded expenses.' }
  ));

  return out;
}

/**
 * Stream the ACNC Annual Financial Report as a DOCX buffer.
 */
export async function generateAcncFinancialDocx({ prefill, overrides }) {
  const bodyXml = buildAcncFinancialBody({ prefill, overrides });
  return packageDocx({
    bodyXml,
    title: overrides?.report_title || 'ACNC Annual Financial Report',
    charityName: prefill?.charity?.name
  });
}

// Shared OOXML packaging — both report types funnel through here so the DOCX
// scaffolding stays in one place.
function packageDocx({ bodyXml, title, charityName }) {
  const docXml = documentXml(bodyXml);
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);

    archive.append(CONTENT_TYPES_XML, { name: '[Content_Types].xml' });
    archive.append(ROOT_RELS_XML, { name: '_rels/.rels' });
    archive.append(coreXml({ title, charityName }), { name: 'docProps/core.xml' });
    archive.append(APP_XML, { name: 'docProps/app.xml' });
    archive.append(docXml, { name: 'word/document.xml' });
    archive.append(DOCUMENT_RELS_XML, { name: 'word/_rels/document.xml.rels' });
    archive.append(STYLES_XML, { name: 'word/styles.xml' });
    archive.append(SETTINGS_XML, { name: 'word/settings.xml' });

    archive.finalize();
  });
}
