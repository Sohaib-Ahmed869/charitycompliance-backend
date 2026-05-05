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
  sections.push(kvTable([
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
    ['Staff size', charity.size_band],
    ['Reporting period', `${fyRange}${fyLabel ? ` (${fyLabel})` : ''}`]
  ]));

  // Registrations & incorporation
  if (incorp.org_type || incorp.state || incorp.number || dgr.status || dgr.item_number) {
    sections.push(heading1('Registrations & incorporation'));
    sections.push(kvTable([
      ['Legal structure', incorp.org_type],
      ['Incorporation state', incorp.state],
      ['Incorporation no.', incorp.number],
      ['DGR status', dgr.status],
      ['DGR item no.', dgr.item_number],
      ['DGR endorsement date', dgr.endorsement_date]
    ]));
  }

  // ACNC classification
  sections.push(heading1('ACNC classification'));
  sections.push(kvTable([
    ['Main charitable activity', acnc.main_activity],
    ['Entity subtype(s)', (acnc.entity_subtypes || []).join(', ')],
    ['Charitable purposes', (acnc.charitable_purposes || []).join(', ')]
  ]));

  // Operating locations
  sections.push(heading1('Operating locations'));
  sections.push(kvTable([
    ['Australian states & territories', (acnc.operating_states || []).join(', ')],
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
  const docXml = documentXml(bodyXml);

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);

    archive.append(CONTENT_TYPES_XML, { name: '[Content_Types].xml' });
    archive.append(ROOT_RELS_XML, { name: '_rels/.rels' });
    archive.append(coreXml({ title: 'Annual Information Statement', charityName: prefill?.charity?.name }), { name: 'docProps/core.xml' });
    archive.append(APP_XML, { name: 'docProps/app.xml' });
    archive.append(docXml, { name: 'word/document.xml' });
    archive.append(DOCUMENT_RELS_XML, { name: 'word/_rels/document.xml.rels' });
    archive.append(STYLES_XML, { name: 'word/styles.xml' });
    archive.append(SETTINGS_XML, { name: 'word/settings.xml' });

    archive.finalize();
  });
}
