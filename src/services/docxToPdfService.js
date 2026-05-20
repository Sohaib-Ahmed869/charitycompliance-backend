/**
 * docxToPdfService — convert a DOCX buffer into a PDF buffer.
 *
 * Pipeline: DOCX → HTML (mammoth) → PDF (Puppeteer / headless Chromium).
 * Mammoth is pure JS so it works on any host; Puppeteer is already a
 * backend dep (used by the approval/policy sign-off PDF generators)
 * so this adds no new platform requirements.
 *
 * The HTML wrapper is intentionally minimal — A4 page size, sensible
 * typography defaults, no Stewardex chrome. Watermarking is applied
 * later by the marketplace flow (Stewardex preview vs licensed-to-org
 * variants) so this layer is content-only.
 */

import mammoth from 'mammoth';
import puppeteer from 'puppeteer';
import { logError, logInfo } from '../utils/logger.js';

/** Mammoth options — keep the conversion lossy-friendly so a DOCX
 *  with unusual styles still produces something readable. */
const MAMMOTH_OPTIONS = {
  styleMap: [
    "p[style-name='Title'] => h1.docx-title",
    "p[style-name='Subtitle'] => h2.docx-subtitle",
    "p[style-name='Heading 1'] => h1",
    "p[style-name='Heading 2'] => h2",
    "p[style-name='Heading 3'] => h3",
    "p[style-name='Heading 4'] => h4",
    "p[style-name='Quote'] => blockquote",
    "r[style-name='Strong'] => strong",
    "r[style-name='Emphasis'] => em"
  ]
};

function wrapHtml(bodyHtml) {
  // Inline styles — Chromium renders these directly. A4 with 18mm
  // margins is the closest match to a normal Word doc.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 18mm 18mm 18mm 18mm; }
  html, body { background: #ffffff; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    color: #111827;
    font-size: 11pt;
    line-height: 1.55;
    margin: 0;
  }
  h1 { font-size: 20pt; font-weight: 700; margin: 0 0 12pt; color: #0a2540; }
  h1.docx-title { font-size: 24pt; }
  h2 { font-size: 15pt; font-weight: 700; margin: 16pt 0 8pt; color: #0a2540; }
  h2.docx-subtitle { font-size: 13pt; color: #475569; font-weight: 500; }
  h3 { font-size: 12pt; font-weight: 700; margin: 14pt 0 6pt; color: #0a2540; }
  h4 { font-size: 11pt; font-weight: 700; margin: 12pt 0 6pt; }
  p  { margin: 0 0 8pt; }
  ul, ol { margin: 0 0 8pt 1.2em; padding: 0; }
  li { margin-bottom: 4pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th, td { border: 1px solid #d1d5db; padding: 5pt 8pt; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  blockquote {
    margin: 0 0 8pt;
    padding: 6pt 10pt;
    border-left: 3px solid #117A8B;
    color: #475569;
    background: #f9fafb;
  }
  hr { border: 0; border-top: 1px solid #d1d5db; margin: 12pt 0; }
</style>
</head>
<body>
${bodyHtml || '<p style="color:#6b7280">This document had no extractable content.</p>'}
</body>
</html>`;
}

/**
 * Convert a DOCX buffer to a PDF buffer. Returns a Buffer.
 * Throws on conversion failure — the caller decides how to surface it.
 */
export async function convertDocxBufferToPdfBuffer(docxBuffer) {
  if (!Buffer.isBuffer(docxBuffer)) {
    throw new Error('convertDocxBufferToPdfBuffer expects a Buffer');
  }

  // ── Stage 1: DOCX → HTML ──────────────────────────────────────────
  let html;
  try {
    const result = await mammoth.convertToHtml({ buffer: docxBuffer }, MAMMOTH_OPTIONS);
    html = result.value;
    if (result.messages?.length) {
      logInfo(`[docx→pdf] mammoth messages: ${result.messages.slice(0, 5).map((m) => m.message).join(' | ')}`);
    }
  } catch (err) {
    logError('[docx→pdf] mammoth conversion failed:', err?.message || err);
    throw new Error('DOCX parse failed');
  }
  const wrappedHtml = wrapHtml(html);

  // ── Stage 2: HTML → PDF via Puppeteer ─────────────────────────────
  // Match the launch flags every other PDF service in this codebase
  // uses (no-sandbox + disable-setuid-sandbox) so EC2 deployment is
  // consistent — the container runs Chromium as root and would
  // otherwise refuse to start under the default sandbox.
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(wrappedHtml, { waitUntil: 'networkidle0' });
    const pdfUint8 = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '18mm', bottom: '18mm', left: '18mm' }
    });
    return Buffer.from(pdfUint8);
  } finally {
    await browser.close().catch(() => {});
  }
}

export default { convertDocxBufferToPdfBuffer };
