/**
 * marketplaceInvoicePdfService — generate a tax-invoice / receipt PDF
 * for a Policy Marketplace purchase.
 *
 * Marketplace purchases are one-off `payment`-mode Stripe Checkout
 * sessions, so Stripe never mints a hosted invoice for them (hosted
 * invoices only exist for subscription billing). To give the buyer a
 * proper receipt — and to attach something to the confirmation email —
 * we build a minimal single-page invoice with pdf-lib, the same PDF
 * library every other PDF service in this codebase already uses
 * (policyPdfBrandingService, approvalMergedPdfService).
 *
 * Pure JS, no native deps — deploys cleanly on Render.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STEWARDEX_LOGO_PATH = path.resolve(__dirname, '..', 'assets', 'stewardex-logo.png');

// Brand colours sampled from the Stewardex wordmark — same paint the
// email template and the marketplace cover page use.
const BRAND_DEEP = rgb(0.043, 0.149, 0.224);   // #0A2E3F
const BRAND_AZURE = rgb(0.067, 0.478, 0.545);  // #117A8B
const INK = rgb(0.20, 0.27, 0.34);
const INK_SOFT = rgb(0.42, 0.52, 0.62);
const LINE = rgb(0.82, 0.85, 0.89);

// Lazy-loaded + cached so we read the PNG off disk once per process.
let stewardexLogoCache = null;
async function loadStewardexLogo() {
  if (stewardexLogoCache !== null) return stewardexLogoCache;
  try {
    const bytes = await fs.readFile(STEWARDEX_LOGO_PATH);
    stewardexLogoCache = bytes;
  } catch (err) {
    logError('[marketplaceInvoicePdf] could not read Stewardex logo:', err?.message || err);
    stewardexLogoCache = null;
  }
  return stewardexLogoCache;
}

/** Format a Date as "19 May 2026". */
function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  return dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Format minor-units (cents) as a currency string, e.g. "A$49.00". */
function formatMoney(cents, currency = 'AUD') {
  const amount = (Number(cents) || 0) / 100;
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: String(currency || 'AUD').toUpperCase(),
    maximumFractionDigits: 2
  }).format(amount);
}

/**
 * Build a derived, human-readable invoice number from the purchase id.
 * Marketplace purchases have no Stripe invoice number, so we synthesise
 * a stable one from the Mongo _id (uppercased last 8 hex chars).
 */
export function marketplaceInvoiceNumber(purchaseId) {
  const hex = String(purchaseId || '').replace(/[^0-9a-fA-F]/g, '');
  const tail = hex.slice(-8).toUpperCase() || 'PENDING';
  return `MP-${tail}`;
}

/**
 * generateMarketplaceInvoicePdf — render the invoice and return PDF bytes.
 *
 * @param {object} opts
 * @param {string} opts.invoiceNumber   — e.g. "MP-1A2B3C4D"
 * @param {string} opts.orgName         — buyer organisation display name
 * @param {string} opts.orgId           — buyer org id (shown as a reference)
 * @param {string} opts.policyTitle     — what was purchased
 * @param {number} [opts.policyVersion] — template version snapshot
 * @param {number} opts.amountCents     — amount paid, in minor units
 * @param {string} [opts.currency]      — ISO currency, defaults AUD
 * @param {Date}   [opts.purchasedAt]   — payment date
 * @param {string} [opts.stripeReceiptRef] — Stripe payment intent / session id
 * @returns {Promise<Buffer>} invoice PDF bytes
 */
export async function generateMarketplaceInvoicePdf({
  invoiceNumber,
  orgName,
  orgId,
  policyTitle,
  policyVersion,
  amountCents,
  currency = 'AUD',
  purchasedAt = new Date(),
  stripeReceiptRef = ''
} = {}) {
  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  // A4 portrait.
  const page = doc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const marginX = 56;
  let cursorY = height - 64;

  // ── Header: logo (or wordmark) on the left, "Tax Invoice" on right ─
  const logoBytes = await loadStewardexLogo();
  if (logoBytes) {
    try {
      const logoImage = await doc.embedPng(logoBytes);
      const targetH = 34;
      const scale = targetH / logoImage.height;
      page.drawImage(logoImage, {
        x: marginX,
        y: cursorY - targetH,
        width: logoImage.width * scale,
        height: targetH
      });
    } catch (err) {
      logError('[marketplaceInvoicePdf] logo embed failed:', err?.message || err);
      page.drawText('Stewardex', { x: marginX, y: cursorY - 24, size: 24, font: fontBold, color: BRAND_DEEP });
    }
  } else {
    page.drawText('Stewardex', { x: marginX, y: cursorY - 24, size: 24, font: fontBold, color: BRAND_DEEP });
  }

  const heading = 'Tax Invoice';
  const headingSize = 22;
  const headingWidth = fontBold.widthOfTextAtSize(heading, headingSize);
  page.drawText(heading, {
    x: width - marginX - headingWidth,
    y: cursorY - 22,
    size: headingSize,
    font: fontBold,
    color: BRAND_DEEP
  });

  cursorY -= 64;

  // Brand divider line.
  page.drawLine({
    start: { x: marginX, y: cursorY },
    end: { x: width - marginX, y: cursorY },
    thickness: 1.4,
    color: BRAND_AZURE
  });
  cursorY -= 30;

  // ── Two-column meta block: Billed To (left) / Invoice info (right) ─
  const colRightX = width / 2 + 20;
  const metaTopY = cursorY;

  // Left column — billed to.
  page.drawText('BILLED TO', { x: marginX, y: cursorY, size: 9, font: fontBold, color: INK_SOFT, characterSpacing: 1.2 });
  cursorY -= 18;
  page.drawText(String(orgName || orgId || 'Customer').slice(0, 60), {
    x: marginX, y: cursorY, size: 13, font: fontBold, color: INK
  });
  cursorY -= 16;
  if (orgId) {
    page.drawText(`Organisation ID: ${String(orgId).slice(0, 60)}`, {
      x: marginX, y: cursorY, size: 9.5, font: fontRegular, color: INK_SOFT
    });
  }

  // Right column — invoice number + date.
  let rightY = metaTopY;
  const drawRightRow = (label, value) => {
    page.drawText(label, { x: colRightX, y: rightY, size: 9, font: fontBold, color: INK_SOFT, characterSpacing: 1.2 });
    rightY -= 14;
    page.drawText(String(value || '-'), { x: colRightX, y: rightY, size: 11, font: fontRegular, color: INK });
    rightY -= 20;
  };
  drawRightRow('INVOICE NUMBER', invoiceNumber);
  drawRightRow('DATE OF ISSUE', formatDate(purchasedAt));
  drawRightRow('STATUS', 'Paid');

  cursorY = Math.min(cursorY, rightY) - 28;

  // ── Line-item table ────────────────────────────────────────────────
  const tableTopY = cursorY;
  const amountColX = width - marginX - 110;

  // Table header band.
  page.drawRectangle({
    x: marginX,
    y: tableTopY - 6,
    width: width - marginX * 2,
    height: 24,
    color: rgb(0.96, 0.97, 0.98)
  });
  page.drawText('DESCRIPTION', { x: marginX + 10, y: tableTopY + 2, size: 9, font: fontBold, color: INK_SOFT, characterSpacing: 1 });
  page.drawText('AMOUNT', { x: amountColX, y: tableTopY + 2, size: 9, font: fontBold, color: INK_SOFT, characterSpacing: 1 });

  cursorY = tableTopY - 24;

  // Line-item row.
  const itemTitle = String(policyTitle || 'Policy template').slice(0, 70);
  page.drawText(itemTitle, { x: marginX + 10, y: cursorY, size: 11, font: fontBold, color: INK });
  const amountStr = formatMoney(amountCents, currency);
  page.drawText(amountStr, { x: amountColX, y: cursorY, size: 11, font: fontRegular, color: INK });
  cursorY -= 15;
  const subLine = `Stewardex Policy Marketplace${policyVersion ? ` - template version ${policyVersion}` : ''}`;
  page.drawText(subLine, { x: marginX + 10, y: cursorY, size: 9, font: fontRegular, color: INK_SOFT });
  cursorY -= 18;

  page.drawLine({
    start: { x: marginX, y: cursorY },
    end: { x: width - marginX, y: cursorY },
    thickness: 0.8,
    color: LINE
  });
  cursorY -= 26;

  // ── Total ──────────────────────────────────────────────────────────
  const totalLabel = 'Total paid';
  page.drawText(totalLabel, { x: amountColX - 80, y: cursorY, size: 12, font: fontBold, color: INK });
  page.drawText(amountStr, { x: amountColX, y: cursorY, size: 13, font: fontBold, color: BRAND_DEEP });
  cursorY -= 14;
  page.drawText('GST included where applicable.', {
    x: amountColX - 80, y: cursorY, size: 8.5, font: fontRegular, color: INK_SOFT
  });

  cursorY -= 40;

  // ── Payment reference ──────────────────────────────────────────────
  if (stripeReceiptRef) {
    page.drawText('Payment reference', { x: marginX, y: cursorY, size: 9, font: fontBold, color: INK_SOFT, characterSpacing: 1 });
    cursorY -= 14;
    page.drawText(String(stripeReceiptRef).slice(0, 80), { x: marginX, y: cursorY, size: 9.5, font: fontRegular, color: INK });
    cursorY -= 26;
  }

  // ── Footer ─────────────────────────────────────────────────────────
  const footerLines = [
    'Thank you for your purchase.',
    'This receipt is generated by Stewardex for your records. Keep it for your accounts.'
  ];
  let footerY = 72;
  for (const line of footerLines) {
    page.drawText(line, { x: marginX, y: footerY, size: 9, font: fontRegular, color: INK_SOFT });
    footerY -= 13;
  }
  page.drawLine({
    start: { x: marginX, y: footerY + 4 },
    end: { x: width - marginX, y: footerY + 4 },
    thickness: 0.6,
    color: LINE
  });

  return Buffer.from(await doc.save());
}

export default { generateMarketplaceInvoicePdf, marketplaceInvoiceNumber };
