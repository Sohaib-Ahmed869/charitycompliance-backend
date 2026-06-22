/**
 * riskZipExportService — audit-grade ZIP of the risk register, streamed to the
 * HTTP response. Contains PDFs (not JSON):
 *
 *   README.txt                       overview
 *   risk-register.pdf                full register PDF (overview of all risks)
 *   risks/
 *     <risk-slug>/
 *       <risk-slug>.pdf              per-risk detail PDF (with attachment links)
 *       attachments/                 the actual attached files (PDFs, images…)
 *
 * Per-risk detail PDFs are rendered with a SINGLE shared puppeteer browser
 * (passed into generateRiskDetailPDF) so we don't launch one browser per risk.
 */

import archiver from 'archiver';
import puppeteer from 'puppeteer';
import { getFileStream, getFileUrl } from './s3Service.js';
import { generateRiskDetailPDF, generateRiskRegisterPDF } from './riskPdfService.js';
import { logError } from '../utils/logger.js';

const slugify = (s, fallback) => {
  const out = String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase();
  return out || fallback;
};

// Resolve S3 keys → 7-day signed URLs so the per-risk PDF can link attachments.
async function withSignedUrls(risk) {
  const attachments = await Promise.all((risk.attachments || []).map(async (a) => ({
    ...a,
    url: a.file_path ? await getFileUrl(a.file_path, 604800).catch(() => null) : null
  })));
  const treatments = await Promise.all((risk.treatments || []).map(async (t) => ({
    ...t,
    evidence: await Promise.all((t.evidence || []).map(async (e) => ({
      ...e,
      url: e.file_path ? await getFileUrl(e.file_path, 604800).catch(() => null) : null
    })))
  })));
  return { attachments, treatments };
}

export async function streamRisksZip(risks = [], res, { orgId, org, logoUrl } = {}) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (e) => logError('[risk-zip] warning', e?.message || e));
  archive.on('error', (e) => {
    logError('[risk-zip] error', e?.message || e);
    try { res.destroy(e); } catch { /* already torn down */ }
  });
  archive.pipe(res);

  archive.append(
    [
      'Risk register export',
      `Organisation: ${org?.name || orgId || ''}`,
      `Generated: ${new Date().toISOString()}`,
      `Risks: ${risks.length}`,
      '',
      'Contents:',
      '  risk-register.pdf              overview of all risks',
      '  risks/<risk>/<risk>.pdf        per-risk detail (with attachment links)',
      '  risks/<risk>/attachments/      the actual attached files',
    ].join('\n'),
    { name: 'README.txt' }
  );

  // Register overview PDF (its own browser — single call).
  try {
    const registerPdf = await generateRiskRegisterPDF({ risks, org }, logoUrl);
    archive.append(Buffer.from(registerPdf), { name: 'risk-register.pdf' });
  } catch (err) {
    logError('[risk-zip] register PDF failed', err?.message || err);
    archive.append(`Register PDF could not be generated: ${err?.message || ''}`, { name: 'risk-register.PDF-FAILED.txt' });
  }

  // One shared browser for every per-risk detail PDF.
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  } catch (err) {
    logError('[risk-zip] could not launch browser for detail PDFs', err?.message || err);
  }

  const usedFolders = new Set();
  for (const r of risks) {
    let folder = slugify(r.title, `risk-${String(r._id).slice(-6)}`);
    let n = 2;
    while (usedFolders.has(folder)) folder = `${slugify(r.title, 'risk')}-${n++}`;
    usedFolders.add(folder);
    const dir = `risks/${folder}`;

    const { attachments, treatments } = await withSignedUrls(r);

    // Per-risk detail PDF (shared browser).
    if (browser) {
      try {
        const buf = await generateRiskDetailPDF({ risk: { ...r, attachments, treatments }, org }, logoUrl, { browser });
        archive.append(Buffer.from(buf), { name: `${dir}/${folder}.pdf` });
      } catch (err) {
        logError('[risk-zip] detail PDF failed', { risk: String(r._id), error: err?.message });
        archive.append(`Detail PDF could not be generated: ${err?.message || ''}`, { name: `${dir}/PDF-FAILED.txt` });
      }
    }

    // The actual attached files (risk attachments + treatment evidence).
    const files = [];
    for (const a of (r.attachments || [])) if (a?.file_path) files.push({ key: a.file_path, name: a.file_name });
    for (const t of (r.treatments || [])) for (const e of (t?.evidence || [])) if (e?.file_path) files.push({ key: e.file_path, name: e.file_name });

    const usedNames = new Set();
    for (const f of files) {
      let name = f.name || f.key.split('/').pop() || 'file';
      while (usedNames.has(name)) name = `dup-${name}`;
      usedNames.add(name);
      try {
        const stream = await getFileStream(f.key);
        archive.append(stream, { name: `${dir}/attachments/${name}` });
      } catch (err) {
        logError('[risk-zip] attachment fetch failed', { key: f.key, error: err?.message });
        archive.append(`Could not retrieve file: ${f.key}\n${err?.message || ''}`, { name: `${dir}/attachments/${name}.MISSING.txt` });
      }
    }
  }

  if (browser) await browser.close().catch(() => {});
  await archive.finalize();
}
