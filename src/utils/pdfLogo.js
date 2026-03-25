/**
 * Org logos in Puppeteer/Chromium PDFs:
 * - Collapse whitespace in data URLs (line breaks break <img src="...">)
 * - Turn relative URLs into absolute (Chromium resolves about:blank badly for setContent)
 * - Optionally embed http(s) images as data URLs so PDFs work offline / in Docker
 */

const DEFAULT_BASE =
  process.env.PUBLIC_API_URL ||
  process.env.API_URL ||
  process.env.BASE_URL ||
  process.env.FRONTEND_URL ||
  'http://127.0.0.1:5000';

export function normalizeLogoUrlForPdf(logoUrl) {
  if (logoUrl == null || logoUrl === '') return '';
  const raw = String(logoUrl).trim();
  if (!raw) return '';
  // Session-only browser URLs — never readable by Node/Puppeteer
  if (raw.startsWith('blob:')) {
    return '';
  }
  if (raw.startsWith('data:')) {
    return raw.replace(/\s+/g, '');
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const base = String(DEFAULT_BASE).replace(/\/$/, '');
  if (raw.startsWith('//')) {
    return `https:${raw}`;
  }
  if (raw.startsWith('/')) {
    return `${base}${raw}`;
  }
  return raw;
}

/**
 * Returns a string safe to use as <img src="..."> (prefer data: URL for reliability).
 */
function fetchTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export async function resolveLogoSrcForPdf(logoUrl) {
  const n = normalizeLogoUrlForPdf(logoUrl);
  if (!n) return '';
  if (n.startsWith('data:')) return n;
  if (!/^https?:\/\//i.test(n)) return n;
  try {
    const res = await fetch(n, { signal: fetchTimeoutSignal(20000) });
    if (!res.ok) return n;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim() || 'image/png';
    if (!/^image\//i.test(ct)) return n;
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return n;
  }
}
