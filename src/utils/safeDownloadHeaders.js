/**
 * Safe download/stream response headers (FUP-015)
 *
 * Files are stored with an attacker-influenced Content-Type. Serving them
 * `inline` lets a browser render HTML/SVG in-origin (stored XSS). This helper:
 *   - sets X-Content-Type-Options: nosniff (stop MIME sniffing),
 *   - only allows `inline` for a small allow-list of safe render types
 *     (PDF + raster images), forcing `attachment` (download) for everything else,
 *   - neutralises actively-dangerous content types to octet-stream so the
 *     browser will never execute/render them even if forced inline elsewhere.
 */

const INLINE_SAFE_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const DANGEROUS_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
]);

/**
 * @param {import('express').Response} res
 * @param {object} opts
 * @param {string} [opts.contentType] - stored Content-Type
 * @param {string} [opts.fileName]    - suggested download name
 * @param {boolean} [opts.preferInline=true] - allow inline for safe types
 */
export function setSafeDownloadHeaders(res, { contentType, fileName = 'file', preferInline = true } = {}) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();

  res.setHeader('X-Content-Type-Options', 'nosniff');

  const effectiveType = DANGEROUS_TYPES.has(ct) || !ct ? 'application/octet-stream' : ct;
  res.setHeader('Content-Type', effectiveType);

  const inline = preferInline && INLINE_SAFE_TYPES.has(ct);
  const safeName = encodeURIComponent(String(fileName || 'file').replace(/[\r\n"\\]/g, '_')) || 'file';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`);

  return inline;
}
