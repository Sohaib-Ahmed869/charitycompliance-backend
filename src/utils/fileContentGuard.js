/**
 * File content guard (FUP-003 / FUP-004 / FUP-009)
 *
 * Validates the *actual bytes* of an uploaded file rather than trusting the
 * client-supplied MIME type or extension (both attacker-controlled). Runs at
 * the single upload choke point (`uploadToS3`), so every module is covered
 * without touching individual routes.
 *
 * Strategy (deliberately conservative to avoid false rejects on real files):
 *   1. Reject dangerous filename extensions anywhere in the name
 *      (blocks double-extension smuggling, e.g. invoice.pdf.html / logo.png.svg).
 *   2. Reject content whose leading bytes clearly indicate active/markup content
 *      (HTML, SVG/XML, scripts) or a native executable (PE / ELF / Mach-O / shell).
 *   3. For binary file types we explicitly allow (pdf, images, office, media),
 *      require the magic bytes to match. Text formats (csv) have no signature
 *      and are passed through — they are always served as attachments.
 */

import { AppError } from '../middleware/errorHandler.js';

/** Extensions that must never appear in an uploaded filename (even as a
 *  non-final segment — that is the double-extension attack). */
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'scr', 'cpl', 'jar',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'mjs', 'jse',
  'wsf', 'wsh', 'hta', 'php', 'phtml', 'php3', 'php4', 'php5', 'phar',
  'asp', 'aspx', 'jsp', 'jspx', 'cgi', 'pl', 'py', 'rb',
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'swf',
  'app', 'deb', 'rpm', 'elf', 'so', 'dylib', 'bin',
]);

const startsWith = (buf, sig, offset = 0) => {
  if (!buf || buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
};

// Signature groups keyed by a logical type. Each is an array of matchers.
const SIGS = {
  pdf: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]),                       // %PDF
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),                       // .PNG
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),                             // JPEG SOI
  gif: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),                       // GIF8
  zip: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04])                        // PK.. (docx/xlsx/pptx)
    || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08]),
  ole: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // legacy Office
  ftyp: (b) => startsWith(b, [0x66, 0x74, 0x79, 0x70], 4),                   // ...ftyp (mp4/mov/m4a)
  ebml: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),                      // webm/mkv
  ogg: (b) => startsWith(b, [0x4f, 0x67, 0x67, 0x53]),                       // OggS
  riff: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]),                      // RIFF (wav/avi/webp)
  mp3: (b) => startsWith(b, [0x49, 0x44, 0x33])                              // ID3
    || (b && b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),       // MPEG frame sync
};

// Binary extensions we allow -> the signature groups any of which is acceptable.
const EXT_ALLOWED_SIGS = {
  pdf: ['pdf'],
  png: ['png'],
  jpg: ['jpg'], jpeg: ['jpg'],
  gif: ['gif'],
  webp: ['riff'],
  doc: ['ole', 'zip'], xls: ['ole', 'zip'], ppt: ['ole', 'zip'],
  docx: ['zip'], xlsx: ['zip'], pptx: ['zip'],
  mp4: ['ftyp'], mov: ['ftyp'], m4a: ['ftyp'],
  webm: ['ebml'],
  avi: ['riff'],
  ogg: ['ogg'],
  wav: ['riff'],
  mp3: ['mp3'],
};

// Extensions with no binary signature (plain text) — skip magic-byte match.
const TEXT_EXTENSIONS = new Set(['csv', 'txt']);

/** Sniff for content that must never be stored regardless of claimed type. */
function looksDangerous(buf) {
  if (!buf || buf.length === 0) return false;
  // Native executables / scripts by leading bytes.
  if (startsWith(buf, [0x4d, 0x5a])) return true;                 // MZ (PE/EXE/DLL)
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return true;     // ELF
  if (startsWith(buf, [0x23, 0x21])) return true;                 // #! shebang
  if (startsWith(buf, [0xca, 0xfe, 0xba, 0xbe])) return true;     // Mach-O / Java class
  if (startsWith(buf, [0xfe, 0xed, 0xfa])) return true;           // Mach-O

  // Markup/script sniff on the first ~1KB, ignoring leading whitespace + BOM.
  let text = buf.slice(0, 1024).toString('latin1');
  text = text.replace(/^﻿/, '').replace(/^\s+/, '').toLowerCase();
  return /^<(?:!doctype\s+html|html|script|svg|\?xml[^>]*>\s*<svg)/.test(text)
    || text.startsWith('<!doctype html')
    || text.startsWith('<html')
    || text.startsWith('<svg')
    || text.startsWith('<script');
}

/**
 * Validate an uploaded file's name and content. Throws AppError(400) on failure.
 * @param {Buffer} buffer   - full file bytes (multer memoryStorage)
 * @param {string} fileName - original client filename
 * @param {string} [mimeType]
 */
export function verifyUploadedFile(buffer, fileName, mimeType) {
  const name = String(fileName || '');
  const segments = name.toLowerCase().split('.').slice(1); // every extension segment

  // (1) Double-extension / dangerous extension anywhere in the name.
  for (const seg of segments) {
    if (DANGEROUS_EXTENSIONS.has(seg)) {
      throw new AppError(
        `File type not allowed (blocked extension: .${seg})`,
        400,
        'INVALID_FILE_TYPE'
      );
    }
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    // Nothing to inspect (e.g. empty placeholder) — let size/other guards handle it.
    return;
  }

  // (2) Positively dangerous content (HTML/SVG/script/executable).
  if (looksDangerous(buffer)) {
    throw new AppError(
      'File content rejected: file appears to contain markup or executable content.',
      400,
      'INVALID_FILE_CONTENT'
    );
  }

  // (3) Magic-byte match for known binary extensions.
  const finalExt = segments.length ? segments[segments.length - 1] : '';
  if (TEXT_EXTENSIONS.has(finalExt)) return;              // csv/txt: no signature
  const allowedGroups = EXT_ALLOWED_SIGS[finalExt];
  if (!allowedGroups) return;                             // unknown ext: extension allow-list already ran in multer
  const ok = allowedGroups.some((g) => SIGS[g] && SIGS[g](buffer));
  if (!ok) {
    throw new AppError(
      `File content does not match its .${finalExt} extension.`,
      400,
      'INVALID_FILE_CONTENT'
    );
  }
}
