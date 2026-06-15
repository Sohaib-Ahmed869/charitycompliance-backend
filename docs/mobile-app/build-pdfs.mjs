// Builds branded Stewardex PDFs from the three Markdown source docs.
// Uses markdown-it (frontend node_modules) + puppeteer (backend node_modules).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const MarkdownIt = require('D:/charitycompliance-frontend/node_modules/markdown-it');
const puppeteer = require('D:/charitycompliance-backend/node_modules/puppeteer');

const DIR = 'D:/charitycompliance-backend/docs/mobile-app';
const LOGO_FULL = 'D:/charitycompliance-frontend/src/assets/logoFull.png';

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const logoB64 = readFileSync(LOGO_FULL).toString('base64');
const logoData = `data:image/png;base64,${logoB64}`;

// Brand palette derived from the Stewardex logo + tailwind primary scale.
const NAVY = '#0c2d48';
const NAVY_DEEP = '#0b2545';
const TEAL = '#2a9d8f';
const PRIMARY = '#1e3a8a';

const docs = [
  {
    file: '1-Stewardex-Mobile-Client-Document.md',
    out: '1-Stewardex-Mobile-Client-Document.pdf',
    title: 'Stewardex Mobile Application',
    subtitle: 'Client Overview & Phase 1 Scope',
    kind: 'Client Document',
  },
  {
    file: '2-Stewardex-Mobile-Frontend-Developer-Guide.md',
    out: '2-Stewardex-Mobile-Frontend-Developer-Guide.pdf',
    title: 'Stewardex Mobile Application',
    subtitle: 'Frontend Developer Guide',
    kind: 'Technical Specification',
  },
  {
    file: '3-Stewardex-Mobile-Backend-Developer-Guide.md',
    out: '3-Stewardex-Mobile-Backend-Developer-Guide.pdf',
    title: 'Stewardex Mobile Application',
    subtitle: 'Backend Developer Guide',
    kind: 'Technical Specification',
  },
];

// Strip the leading H1 + the bold meta block that the markdown already carries,
// since the cover page presents that information.
function stripLeadingMeta(src) {
  const lines = src.split('\n');
  let i = 0;
  // skip first H1
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i] && lines[i].startsWith('# ')) i++;
  // skip following blank + bold meta lines + first --- rule
  let sawRule = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (t.startsWith('**')) continue;
    if (t.startsWith('>')) continue;
    if (t === '---') { i++; sawRule = true; break; }
    break;
  }
  return lines.slice(i).join('\n');
}

function cover(doc) {
  return `
  <section class="cover">
    <div class="cover-top">
      <img class="cover-logo" src="${logoData}" />
    </div>
    <div class="cover-mid">
      <div class="kind-chip">${doc.kind}</div>
      <h1 class="cover-title">${doc.title}</h1>
      <h2 class="cover-subtitle">${doc.subtitle}</h2>
      <div class="cover-rule"></div>
      <table class="cover-meta">
        <tr><td>Release</td><td>Phase 1</td></tr>
        <tr><td>Date</td><td>15 June 2026</td></tr>
        <tr><td>Status</td><td>For review</td></tr>
      </table>
    </div>
    <div class="cover-foot">
      <span>Stewardex — Charity Governance &amp; Compliance Suite</span>
      <span class="cover-foot-conf">Confidential</span>
    </div>
  </section>`;
}

const css = `
  @page { margin: 22mm 16mm 20mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter Tight', 'Segoe UI', Arial, sans-serif;
    color: #1f2937; font-size: 10.6pt; line-height: 1.62; background: #ffffff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ---------- Cover ---------- */
  .cover {
    position: relative; height: 247mm; page-break-after: always;
    display: flex; flex-direction: column; justify-content: space-between;
    background:
      radial-gradient(120% 80% at 100% 0%, rgba(42,157,143,0.10), transparent 55%),
      linear-gradient(160deg, #ffffff 0%, #f4f8fb 100%);
    border-radius: 6px; padding: 14mm 12mm;
  }
  .cover::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
    background: linear-gradient(${NAVY_DEEP}, ${TEAL}); border-radius: 6px 0 0 6px;
  }
  .cover-logo { width: 230px; }
  .cover-mid { margin-bottom: 6mm; }
  .kind-chip {
    display: inline-block; background: ${TEAL}; color: #fff;
    font-size: 9pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    padding: 5px 12px; border-radius: 20px; margin-bottom: 16px;
  }
  .cover-title { font-size: 30pt; color: ${NAVY}; margin: 0 0 4px; font-weight: 800; letter-spacing: -.5px; }
  .cover-subtitle { font-size: 16pt; color: ${TEAL}; margin: 0; font-weight: 600; }
  .cover-rule { height: 3px; width: 90px; background: ${NAVY}; margin: 22px 0; border-radius: 3px; }
  .cover-meta { font-size: 10.5pt; border-collapse: collapse; }
  .cover-meta td { padding: 3px 0; }
  .cover-meta td:first-child { color: #64748b; width: 90px; font-weight: 600; }
  .cover-meta td:last-child { color: ${NAVY}; font-weight: 600; }
  .cover-foot {
    display: flex; justify-content: space-between; align-items: center;
    border-top: 1px solid #d8e2ea; padding-top: 10px; color: #64748b; font-size: 8.6pt;
  }
  .cover-foot-conf { color: ${TEAL}; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }

  /* ---------- Content ---------- */
  .content { padding-top: 2mm; }
  h1, h2, h3, h4 { color: ${NAVY}; font-weight: 700; line-height: 1.25; }
  h1 { font-size: 18pt; margin: 0 0 10px; }
  h2 {
    font-size: 14pt; margin: 26px 0 10px; padding-bottom: 6px;
    border-bottom: 2px solid #e2e8ef; page-break-after: avoid;
  }
  h2::before {
    content: ''; display: inline-block; width: 9px; height: 9px; border-radius: 2px;
    background: ${TEAL}; margin-right: 9px; vertical-align: middle;
  }
  h3 { font-size: 11.8pt; margin: 18px 0 6px; color: ${PRIMARY}; page-break-after: avoid; }
  h4 { font-size: 10.8pt; margin: 14px 0 5px; color: ${PRIMARY}; }
  p { margin: 7px 0; }
  ul, ol { margin: 7px 0; padding-left: 20px; }
  li { margin: 3px 0; }
  strong { color: ${NAVY}; }
  a { color: ${TEAL}; text-decoration: none; }

  code {
    font-family: 'IBM Plex Mono', 'Consolas', monospace; font-size: 8.8pt;
    background: #eef3f7; color: ${NAVY_DEEP}; padding: 1px 5px; border-radius: 4px;
  }
  pre {
    background: ${NAVY_DEEP}; color: #e6edf3; padding: 12px 14px; border-radius: 8px;
    overflow-x: auto; font-size: 8.6pt; line-height: 1.5; page-break-inside: avoid;
    border-left: 4px solid ${TEAL};
  }
  pre code { background: transparent; color: inherit; padding: 0; }

  table {
    border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 9.3pt;
    page-break-inside: avoid;
  }
  th {
    background: ${NAVY}; color: #fff; text-align: left; padding: 7px 9px;
    font-weight: 600; font-size: 9pt;
  }
  td { padding: 6px 9px; border-bottom: 1px solid #e2e8ef; vertical-align: top; }
  tr:nth-child(even) td { background: #f6f9fb; }

  blockquote {
    margin: 12px 0; padding: 10px 14px; background: #eef6f5;
    border-left: 4px solid ${TEAL}; border-radius: 0 6px 6px 0; color: #334155;
  }
  blockquote p { margin: 3px 0; }
  hr { border: none; border-top: 1px solid #e2e8ef; margin: 18px 0; }
`;

function pageHtml(doc, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
  <body>${cover(doc)}<div class="content">${bodyHtml}</div></body></html>`;
}

const headerTemplate = `
  <div style="width:100%; font-size:7pt; color:#94a3b8; padding:0 16mm;
       display:flex; justify-content:space-between; align-items:center;
       -webkit-print-color-adjust:exact;">
    <img src="${logoData}" style="height:13px;" />
    <span style="letter-spacing:.04em;">STEWARDEX MOBILE — PHASE 1</span>
  </div>`;

const footerTemplate = `
  <div style="width:100%; font-size:7.5pt; color:#94a3b8; padding:0 16mm;
       display:flex; justify-content:space-between; align-items:center;
       border-top:1px solid #e2e8ef; -webkit-print-color-adjust:exact;">
    <span>© 2026 Stewardex · Confidential</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

for (const doc of docs) {
  const raw = readFileSync(path.join(DIR, doc.file), 'utf8');
  const body = md.render(stripLeadingMeta(raw));
  const html = pageHtml(doc, body);

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: path.join(DIR, doc.out),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    margin: { top: '22mm', bottom: '20mm', left: '0', right: '0' },
    // Suppress header/footer on the cover page is not natively supported;
    // the cover's own padding keeps content clear of the chrome.
  });
  await page.close();
  console.log('Built', doc.out);
}

await browser.close();
console.log('Done.');
