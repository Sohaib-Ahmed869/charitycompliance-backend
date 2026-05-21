/**
 * Renders cost-estimate.html to a client-facing PDF using the Puppeteer
 * instance already bundled with this project.
 *
 * Usage:  node scripts/cost-report/generate-cost-pdf.mjs
 */
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'cost-estimate.html');
const outPath = path.join(__dirname, '..', '..', 'Running-Cost-Estimate.pdf');

const run = async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: outPath,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  await browser.close();
  console.log(`PDF written: ${outPath}`);
};

run().catch((err) => {
  console.error('PDF generation failed:', err);
  process.exit(1);
});
