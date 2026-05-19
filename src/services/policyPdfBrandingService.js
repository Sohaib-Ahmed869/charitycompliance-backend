/**
 * policyPdfBrandingService — shared PDF branding for marketplace
 * purchases.
 *
 * What it does:
 *   1. Prepends a full cover page (big centered logo, org name, policy
 *      title, purchase date).
 *   2. Stamps a small top-right logo + org name on every other page.
 *
 * Reused by:
 *   • services/marketplaceDeliveryService.js   (tenant purchases)
 *   • services/publicMarketplaceDeliveryService.js  (guest purchases)
 *
 * Why this exists separately: both delivery paths used to share an
 * inlined pdf-lib block. Extracting it to one place means a design
 * tweak only has to happen here, not in two services that are easy
 * to leave inconsistent.
 *
 * pdf-lib only embeds PNG and JPG — SVG/WebP/AVIF logos silently
 * fall through to a text-only cover.
 */

import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, logWarn } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STEWARDEX_LOGO_PATH = path.resolve(__dirname, '..', 'assets', 'stewardex-logo.png');

// Lazy-loaded + cached so we read the PNG off disk once per process.
let stewardexLogoCache = null;
async function loadStewardexLogo() {
  if (stewardexLogoCache !== null) return stewardexLogoCache;
  try {
    const bytes = await fs.readFile(STEWARDEX_LOGO_PATH);
    stewardexLogoCache = { bytes, mime: 'image/png' };
  } catch (err) {
    logError('[policyPdfBranding] could not read Stewardex logo:', err?.message || err);
    stewardexLogoCache = { bytes: null, mime: '' };
  }
  return stewardexLogoCache;
}

// ── helpers ─────────────────────────────────────────────────────────

async function embedLogo(doc, logoBytes, logoMime) {
  if (!logoBytes || !logoMime) return null;
  try {
    if (logoMime.includes('png')) return await doc.embedPng(logoBytes);
    if (logoMime.includes('jpeg') || logoMime.includes('jpg')) return await doc.embedJpg(logoBytes);
    logWarn(`[policyPdfBranding] unsupported logo mime "${logoMime}"`);
    return null;
  } catch (err) {
    logError('[policyPdfBranding] logo embed failed:', err?.message || err);
    return null;
  }
}

/** Format a Date as "19 May 2026". */
function formatPurchaseDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return dt.toLocaleDateString('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

/** Wrap a string at `maxWidth` using the given font/size, returning lines. */
function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── public API ──────────────────────────────────────────────────────

/**
 * Brand a marketplace PDF: add a cover page + small per-page header.
 *
 * @param {Buffer} pdfBytes — source PDF bytes
 * @param {object} opts
 * @param {string} opts.orgName       — buyer / licensee organisation
 * @param {Buffer} [opts.logoBytes]   — PNG or JPG; SVG/WebP not supported
 * @param {string} [opts.logoMime]    — mime type matching logoBytes
 * @param {string} [opts.policyTitle] — appears on cover and (optionally) caption
 * @param {Date}   [opts.purchasedAt] — defaults to "now"
 * @returns {Promise<Buffer>} branded PDF bytes
 */
export async function brandMarketplacePdf(pdfBytes, {
  orgName,
  logoBytes,
  logoMime,
  policyTitle = '',
  purchasedAt = new Date()
} = {}) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const logoImage = await embedLogo(doc, logoBytes, logoMime);

  const safeOrgName = String(orgName || 'Licensed organisation').slice(0, 120);
  const safeTitle = String(policyTitle || '').slice(0, 200);
  const dateLine = `Purchased on ${formatPurchaseDate(purchasedAt)}`;

  // Use the existing first page's dimensions for the cover so it
  // doesn't look mismatched in viewers that auto-fit per page.
  const pages = doc.getPages();
  const reference = pages[0];
  const refSize = reference?.getSize() || { width: 595.28, height: 841.89 }; // A4 default

  // ── 1. Cover page ────────────────────────────────────────────────
  // Inserted at index 0 so it becomes the first page everyone sees.
  const cover = doc.insertPage(0, [refSize.width, refSize.height]);
  drawCoverPage(cover, {
    fontBold,
    fontRegular,
    logoImage,
    orgName: safeOrgName,
    policyTitle: safeTitle,
    dateLine
  });

  // ── 2. Per-page top-right logo on the original content ───────────
  // Skip the cover (index 0 now); iterate the original pages which
  // are at indices 1..n after the insert.
  const allPages = doc.getPages();
  for (let i = 1; i < allPages.length; i++) {
    drawPageHeader(allPages[i], {
      fontBold,
      logoImage,
      orgName: safeOrgName
    });
  }

  return Buffer.from(await doc.save());
}

// ── drawing ─────────────────────────────────────────────────────────

function drawCoverPage(page, { fontBold, fontRegular, logoImage, orgName, policyTitle, dateLine }) {
  const { width, height } = page.getSize();
  const centerX = width / 2;

  // Subtle "Stewardex Policy" eyebrow at the top.
  const eyebrow = 'Policy Document';
  const eyebrowSize = 10;
  const eyebrowWidth = fontBold.widthOfTextAtSize(eyebrow, eyebrowSize);
  page.drawText(eyebrow, {
    x: centerX - eyebrowWidth / 2,
    y: height - 64,
    size: eyebrowSize,
    font: fontBold,
    color: rgb(0.30, 0.40, 0.52),
    characterSpacing: 1.6
  });

  // Big centered logo. Fit to a 220-pt-tall, 360-pt-wide box.
  const logoBoxH = 180;
  const logoBoxW = Math.min(360, width - 120);
  const logoCenterY = height / 2 + 60; // sits in the upper-middle
  if (logoImage) {
    const scale = Math.min(logoBoxW / logoImage.width, logoBoxH / logoImage.height);
    const logoW = logoImage.width * scale;
    const logoH = logoImage.height * scale;
    page.drawImage(logoImage, {
      x: centerX - logoW / 2,
      y: logoCenterY - logoH / 2,
      width: logoW,
      height: logoH
    });
  } else {
    // No logo — draw the org name where the logo would have been so
    // the cover never looks empty.
    const fallbackSize = 36;
    const fallbackWidth = fontBold.widthOfTextAtSize(orgName, fallbackSize);
    page.drawText(orgName, {
      x: centerX - Math.min(fallbackWidth, width - 80) / 2,
      y: logoCenterY,
      size: fallbackSize,
      font: fontBold,
      color: rgb(0.043, 0.149, 0.224)
    });
  }

  // Separator line.
  const sepY = logoCenterY - logoBoxH / 2 - 32;
  page.drawLine({
    start: { x: width * 0.30, y: sepY },
    end:   { x: width * 0.70, y: sepY },
    thickness: 0.8,
    color: rgb(0.78, 0.82, 0.86)
  });

  // Org name (big), then policy title (smaller), then date.
  let cursorY = sepY - 28;
  const orgSize = logoImage ? 22 : 14; // when logo is missing, the big name above already covers this slot
  if (logoImage) {
    const orgLines = wrapText(orgName, fontBold, orgSize, width - 96);
    for (const line of orgLines) {
      const lineW = fontBold.widthOfTextAtSize(line, orgSize);
      page.drawText(line, {
        x: centerX - lineW / 2,
        y: cursorY,
        size: orgSize,
        font: fontBold,
        color: rgb(0.07, 0.14, 0.22)
      });
      cursorY -= orgSize + 4;
    }
    cursorY -= 14;
  }

  if (policyTitle) {
    const titleSize = 16;
    const titleLines = wrapText(policyTitle, fontRegular, titleSize, width - 120);
    for (const line of titleLines) {
      const lineW = fontRegular.widthOfTextAtSize(line, titleSize);
      page.drawText(line, {
        x: centerX - lineW / 2,
        y: cursorY,
        size: titleSize,
        font: fontRegular,
        color: rgb(0.30, 0.40, 0.52)
      });
      cursorY -= titleSize + 4;
    }
    cursorY -= 10;
  }

  // Date chip-style line.
  const dateSize = 11;
  const dateWidth = fontRegular.widthOfTextAtSize(dateLine, dateSize);
  page.drawText(dateLine, {
    x: centerX - dateWidth / 2,
    y: cursorY,
    size: dateSize,
    font: fontRegular,
    color: rgb(0.42, 0.52, 0.62)
  });

  // Footer — small "Licensed copy" line at the bottom.
  const footer = `Licensed copy — prepared for ${orgName}`;
  const footerSize = 9;
  const footerWidth = fontRegular.widthOfTextAtSize(footer, footerSize);
  page.drawText(footer, {
    x: centerX - Math.min(footerWidth, width - 80) / 2,
    y: 48,
    size: footerSize,
    font: fontRegular,
    color: rgb(0.55, 0.61, 0.69)
  });
}

function drawPageHeader(page, { fontBold, logoImage, orgName }) {
  const { width, height } = page.getSize();
  const padding = 14;

  if (logoImage) {
    const targetH = 18;
    const scale = targetH / logoImage.height;
    const logoW = Math.min(logoImage.width * scale, 72);
    const drawnH = (logoW / (logoImage.width * scale)) * targetH;
    page.drawImage(logoImage, {
      x: width - padding - logoW,
      y: height - padding - drawnH,
      width: logoW,
      height: drawnH
    });
    // Org name caption to the LEFT of the logo, right-aligned to
    // the logo's left edge.
    const captionSize = 8.5;
    const captionWidth = fontBold.widthOfTextAtSize(orgName, captionSize);
    const captionX = width - padding - logoW - 6 - captionWidth;
    if (captionX > padding) {
      page.drawText(orgName, {
        x: captionX,
        y: height - padding - drawnH / 2 - captionSize / 2 + 0.5,
        size: captionSize,
        font: fontBold,
        color: rgb(0.45, 0.52, 0.60)
      });
    }
  } else {
    // No logo — just the org name in small grey.
    const captionSize = 9;
    const captionWidth = fontBold.widthOfTextAtSize(orgName, captionSize);
    page.drawText(orgName, {
      x: Math.max(padding, width - padding - captionWidth),
      y: height - padding - captionSize,
      size: captionSize,
      font: fontBold,
      color: rgb(0.45, 0.52, 0.60)
    });
  }
}

/**
 * Stewardex-branded preview. Used for marketplace preview-stream
 * endpoints (card thumbnails + preview modal). Differs from the
 * purchased-document branding: NO cover page, just a small
 * Stewardex stamp at the top-left of each page plus a faint
 * diagonal "STEWARDEX" watermark so the page is clearly a sample.
 * The org-name caption / purchase-date / cover page are all kept
 * for the buyer's actual delivered copy.
 */
export async function brandStewardexPreviewPdf(pdfBytes /* , { policyTitle } = {} */) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const stewardexLogo = await loadStewardexLogo();
  const logoImage = await embedLogo(doc, stewardexLogo.bytes, stewardexLogo.mime);

  const pages = doc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();

    // ── Top-left stamp ────────────────────────────────────────────
    const padding = 14;
    if (logoImage) {
      const targetH = 22; // a touch bigger than the purchased top-right stamp
      const scale = targetH / logoImage.height;
      const logoW = Math.min(logoImage.width * scale, 100);
      const drawnW = logoW;
      const drawnH = (logoW / (logoImage.width * scale)) * targetH;
      page.drawImage(logoImage, {
        x: padding,
        y: height - padding - drawnH,
        width: drawnW,
        height: drawnH
      });
    } else {
      // Logo not on disk → fall back to a "Stewardex" wordmark.
      const fallbackSize = 12;
      page.drawText('Stewardex', {
        x: padding,
        y: height - padding - fallbackSize,
        size: fallbackSize,
        font: fontBold,
        color: rgb(0.043, 0.149, 0.224)
      });
    }

    // ── Diagonal "STEWARDEX • PREVIEW" sample watermark ──────────
    // Size the text so its rotated bounding box fits the page width
    // comfortably (otherwise much of it ran off-screen on A4).
    // Compute the actual centered origin from the rotation angle so
    // the text reads centered no matter the page aspect ratio.
    const wmText = 'STEWARDEX • PREVIEW';
    const angleDeg = -28;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    // Pick a font size so the rotated text occupies ~78% of page width.
    const targetRotatedWidth = width * 0.78;
    // Try a sensible size, then back off if the measured text is wider.
    let wmSize = Math.min(width, height) * 0.08;
    let wmTextWidth = fontBold.widthOfTextAtSize(wmText, wmSize);
    let rotatedHorizontal = Math.abs(wmTextWidth * cosA);
    if (rotatedHorizontal > targetRotatedWidth) {
      wmSize = wmSize * (targetRotatedWidth / rotatedHorizontal);
      wmTextWidth = fontBold.widthOfTextAtSize(wmText, wmSize);
    }
    // For pdf-lib, `rotate` pivots around the text's origin (bottom-
    // left). To center the rotated text on the page we offset the
    // origin by half the text width along the rotation axis.
    const cx = width / 2;
    const cy = height / 2;
    const dx = (wmTextWidth / 2) * cosA;
    const dy = (wmTextWidth / 2) * sinA;
    page.drawText(wmText, {
      x: cx - dx,
      y: cy - dy - wmSize * 0.3,
      size: wmSize,
      font: fontBold,
      color: rgb(0.043, 0.149, 0.224),
      // Bumped from 0.07 — at 0.07 the watermark was effectively
      // invisible once react-pdf downscaled the page to a 240-pt
      // card thumbnail.
      opacity: 0.14,
      rotate: degrees(angleDeg)
    });
  }

  return Buffer.from(await doc.save());
}

export default { brandMarketplacePdf, brandStewardexPreviewPdf };
