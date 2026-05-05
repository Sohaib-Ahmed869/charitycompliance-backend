/**
 * One-shot generator for The Stewardex Handbook.
 *
 * Run from the backend root:
 *   node scripts/generateOnboardingHandbook.js [output-path]
 *
 * If no output path is given, writes to ./stewardex-onboarding-handbook.pdf
 * in the backend folder. The handbook is platform documentation — no tenant
 * data is fetched; pass a `--charity "Name"` flag if you want a specific
 * "Prepared for" mark on the cover, otherwise it falls back to a neutral
 * placeholder.
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateOnboardingHandbookPdf } from '../src/services/onboardingHandbookService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = { output: null, charity: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--charity') {
      args.charity = rest[i + 1] || '';
      i += 1;
    } else if (a === '--output' || a === '-o') {
      args.output = rest[i + 1] || '';
      i += 1;
    } else if (!args.output && !a.startsWith('-')) {
      args.output = a;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = args.output
    ? path.resolve(args.output)
    : path.resolve(__dirname, '..', 'stewardex-onboarding-handbook.pdf');

  const org = args.charity
    ? { name: args.charity, trading_name: args.charity }
    : { name: 'Sample Charity' };

  console.log('Generating handbook…');
  const pdf = await generateOnboardingHandbookPdf({ org });
  writeFileSync(outPath, pdf);
  console.log(`✔ Wrote ${pdf.length} bytes to ${outPath}`);
}

main().catch((err) => {
  console.error('Handbook generation failed', err);
  process.exit(1);
});
