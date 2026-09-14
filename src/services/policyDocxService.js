/**
 * policyDocxService — produce a branded, EDITABLE Word (.docx) copy of
 * a marketplace policy template, so an organisation can tweak the
 * wording before putting it through their approval workflow.
 *
 * Pipeline (uniform regardless of the template's original format):
 *
 *   source file ─┬─ DOCX → (use as-is)
 *                └─ PDF  → LibreOffice headless → DOCX
 *        → HTML            (mammoth — images inlined as data URIs)
 *        → DOCX            (html-to-docx, with a branded header band:
 *                           org name + "licensed marketplace policy")
 *
 * REQUIREMENT: PDF-source templates need LibreOffice ('soffice') on the
 * host PATH. DOCX-source templates do not (mammoth is pure JS). Override
 * the binary location with the LIBREOFFICE_PATH env var. If LibreOffice
 * is missing, conversion of a PDF template throws a clear error and the
 * caller falls back to the PDF deliverable.
 *
 * Counterpart of docxToPdfService.js (the reverse direction).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import HTMLtoDOCX from 'html-to-docx';
import { logError, logInfo } from '../utils/logger.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// LibreOffice binary — overridable per-host. On Linux it's usually
// `soffice` (or `libreoffice`); set LIBREOFFICE_PATH for a custom install.
const SOFFICE = process.env.LIBREOFFICE_PATH || 'soffice';

// Hard cap so a stuck LibreOffice process can't wedge a request.
const LIBREOFFICE_TIMEOUT_MS = 60_000;

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

/**
 * Convert a buffer with LibreOffice headless. Writes the input to a
 * private temp dir, runs `soffice --convert-to`, reads the output back,
 * and always cleans the temp dir up.
 */
async function libreOfficeConvert(inputBytes, inputExt, targetExt) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sx-docx-'));
  try {
    const inPath = path.join(dir, `source.${inputExt}`);
    await writeFile(inPath, inputBytes);

    await new Promise((resolve, reject) => {
      const proc = spawn(
        SOFFICE,
        ['--headless', '--norestore', '--nologo', '--convert-to', targetExt, '--outdir', dir, inPath],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('LibreOffice conversion timed out'));
      }, LIBREOFFICE_TIMEOUT_MS);
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(
          `LibreOffice not available — set LIBREOFFICE_PATH or install it (${SOFFICE}): ${e.message}`
        ));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`LibreOffice exited ${code}: ${stderr.slice(0, 300)}`));
      });
    });

    const files = await readdir(dir);
    const outName = files.find((f) => f.toLowerCase().endsWith(`.${targetExt}`));
    if (!outName) throw new Error('LibreOffice produced no output file');
    return await readFile(path.join(dir, outName));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Branded header band repeated on every page of the generated doc. */
function buildHeaderHtml(orgName) {
  const safeOrg = String(orgName || 'Your organisation').replace(/[<>]/g, '').slice(0, 120);
  return `
    <div style="border-bottom:1px solid #cbd5e1;padding-bottom:4px;">
      <span style="font-size:11pt;font-weight:bold;color:#0a2540;">${safeOrg}</span>
      <span style="font-size:8pt;color:#64748b;"> &nbsp;·&nbsp; Licensed marketplace policy — editable draft</span>
    </div>
  `.trim();
}

/** A logo + org-name banner prepended to the body (first thing on page 1). */
function buildBodyBanner({ orgName, logoBytes, logoMime }) {
  const safeOrg = String(orgName || 'Your organisation').replace(/[<>]/g, '').slice(0, 120);
  let logoHtml = '';
  if (logoBytes && Buffer.isBuffer(logoBytes) && logoBytes.length > 0) {
    const mime = /jpe?g/i.test(logoMime || '') ? 'image/jpeg' : 'image/png';
    logoHtml = `<img src="data:${mime};base64,${logoBytes.toString('base64')}" height="40" /><br/>`;
  }
  return `
    <div style="margin-bottom:14pt;">
      ${logoHtml}
      <div style="font-size:9pt;color:#64748b;margin-top:6pt;">
        Prepared for <strong>${safeOrg}</strong>. This is an editable draft —
        review and amend the wording before submitting it for approval.
      </div>
      <hr style="border:0;border-top:1px solid #cbd5e1;margin:10pt 0;" />
    </div>
  `.trim();
}

function wrapHtml(bodyHtml) {
  // Minimal print-friendly styling — html-to-docx maps these to Word styles.
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  body { font-family: 'Calibri','Segoe UI',Arial,sans-serif; font-size: 11pt; color: #111827; line-height: 1.5; }
  h1 { font-size: 19pt; color: #0a2540; }
  h1.docx-title { font-size: 23pt; }
  h2 { font-size: 14pt; color: #0a2540; }
  h2.docx-subtitle { font-size: 12pt; color: #475569; font-weight: normal; }
  h3 { font-size: 12pt; color: #0a2540; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d1d5db; padding: 5pt 8pt; }
  th { background: #f3f4f6; }
  blockquote { border-left: 3px solid #117A8B; padding-left: 10pt; color: #475569; }
</style></head><body>${bodyHtml || '<p>This document had no extractable content.</p>'}</body></html>`;
}

/**
 * generateBrandedPolicyDocx — main entry point.
 *
 * @param {object}  args
 * @param {Buffer}  args.sourceBytes   original template file bytes
 * @param {string}  args.sourceFormat  'pdf' | 'docx'
 * @param {string}  args.orgName       organisation display name (header)
 * @param {Buffer} [args.logoBytes]    org logo (PNG/JPG) for the banner
 * @param {string} [args.logoMime]     logo mime type
 * @returns {Promise<Buffer>} a branded, editable .docx
 */
export async function generateBrandedPolicyDocx({
  sourceBytes,
  sourceFormat,
  orgName,
  logoBytes = null,
  logoMime = ''
}) {
  if (!Buffer.isBuffer(sourceBytes)) {
    throw new Error('generateBrandedPolicyDocx expects a Buffer');
  }

  // ── Stage 1: ensure we have a DOCX buffer ───────────────────────────
  let docxBuffer;
  if (String(sourceFormat).toLowerCase() === 'pdf') {
    logInfo('[policy→docx] converting PDF → DOCX via LibreOffice');
    docxBuffer = await libreOfficeConvert(sourceBytes, 'pdf', 'docx');
  } else {
    docxBuffer = sourceBytes;
  }

  // ── Stage 2: DOCX → HTML (mammoth inlines images as data URIs) ──────
  let contentHtml;
  try {
    const result = await mammoth.convertToHtml({ buffer: docxBuffer }, MAMMOTH_OPTIONS);
    contentHtml = result.value;
  } catch (err) {
    logError('[policy→docx] mammoth conversion failed:', err?.message || err);
    throw new Error('Policy content could not be parsed for Word export');
  }

  // ── Stage 3: HTML → branded DOCX ────────────────────────────────────
  const banner = buildBodyBanner({ orgName, logoBytes, logoMime });
  const fullHtml = wrapHtml(banner + contentHtml);
  const headerHtml = buildHeaderHtml(orgName);

  const docx = await HTMLtoDOCX(fullHtml, headerHtml, {
    header: true,
    footer: false,
    pageNumber: false,
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    table: { row: { cantSplit: true } }
  });

  // html-to-docx returns a Buffer under Node; normalise just in case.
  return Buffer.isBuffer(docx) ? docx : Buffer.from(docx);
}

export default { generateBrandedPolicyDocx, DOCX_MIME };
