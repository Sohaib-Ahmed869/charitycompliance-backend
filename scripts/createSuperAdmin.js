/**
 * Create (or rotate) a Calcite super-admin account.
 *
 * Stores a bcrypt hash in the Router DB `super_admins` collection. The
 * plaintext password is generated cryptographically (24 chars, mixed
 * symbol set) and printed ONCE — the script does not log it again, the DB
 * does not store it, and there is no recovery flow. Save it to your
 * password manager immediately.
 *
 * USAGE
 *   # Interactive (recommended) — prompts for email + full name
 *   node scripts/createSuperAdmin.js
 *
 *   # Non-interactive (CI / docs) — provide email + name as args
 *   node scripts/createSuperAdmin.js sohaib@calcite.tech "Sohaib Ahmed"
 *
 *   # Bring your own password (explicit) — must be ≥16 chars
 *   node scripts/createSuperAdmin.js sohaib@calcite.tech "Sohaib Ahmed" --password='Custom-Long-Password!'
 *
 *   # Rotate (replace) the password for an existing super-admin
 *   node scripts/createSuperAdmin.js sohaib@calcite.tech --rotate
 */

import readline from 'readline';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { connectRouterDB } from '../src/config/database.js';
import getRouterModels from '../src/db/models/routerModels.js';
import { logInfo, logError } from '../src/utils/logger.js';

const BCRYPT_ROUNDS = 12;
const PASSWORD_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 16;

// Symbol set chosen so generated passwords copy/paste cleanly across most
// terminals and shells: omits look-alikes (0/O, 1/l/I) and shell-special
// characters that need escaping ($, `, ", ', \, ;, &, |, <, >, *, ?, !).
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' +     // upper, no I/O
  'abcdefghijkmnopqrstuvwxyz' +    // lower, no l
  '23456789' +                     // digits, no 0/1
  '@#%^_+-=:.,';                   // safe punctuation only

function generateStrongPassword(length = PASSWORD_LENGTH) {
  const out = [];
  const buf = crypto.randomBytes(length * 2);
  let i = 0;
  while (out.length < length) {
    // Rejection sampling so we don't bias the distribution.
    const byte = buf[i++ % buf.length];
    if (byte < (256 - (256 % PASSWORD_ALPHABET.length))) {
      out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
    }
    if (i > length * 8) {
      // Pathological — re-seed and continue.
      crypto.randomFillSync(buf);
      i = 0;
    }
  }
  return out.join('');
}

function prompt(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent && rl._writeToOutput) {
      // Best-effort no-echo for terminals that support it; otherwise just
      // prints normally (interactive scripts only — never used in CI).
      rl._writeToOutput = function (s) { rl.output.write(s.replace(/./g, '*')); };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const argEmail = positional[0];
  const argName = positional[1];
  const customPassword = flags.password || null;
  const isRotate = !!flags.rotate;

  let email = argEmail;
  let fullName = argName;

  // Interactive prompts if anything is missing.
  if (!email) email = await prompt('Email: ');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('✖ A valid email is required.');
    process.exit(1);
  }
  email = email.toLowerCase().trim();

  if (!isRotate && !fullName) fullName = await prompt('Full name: ');
  if (!isRotate && !fullName) {
    console.error('✖ Full name is required.');
    process.exit(1);
  }

  // Password — either generated, provided, or interactively asked for.
  let plaintextPassword = customPassword;
  if (!plaintextPassword) {
    plaintextPassword = generateStrongPassword();
  } else if (plaintextPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(`✖ Custom password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  await connectRouterDB();
  const { SuperAdmin } = getRouterModels();

  const existing = await SuperAdmin.findOne({ email });
  if (existing && !isRotate) {
    console.error(`✖ A super-admin with email ${email} already exists.`);
    console.error('  Use --rotate to replace the password instead, or pick a different email.');
    process.exit(1);
  }
  if (!existing && isRotate) {
    console.error(`✖ No super-admin with email ${email} to rotate. Create one first (without --rotate).`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(plaintextPassword, BCRYPT_ROUNDS);

  if (isRotate) {
    await SuperAdmin.updateOne(
      { _id: existing._id },
      {
        $set: {
          password_hash: hash,
          failed_login_attempts: 0,
          locked_until: null,
          updated_at: new Date()
        }
      }
    );
    logInfo('SuperAdmin password rotated', { email });
  } else {
    await SuperAdmin.create({
      email,
      password_hash: hash,
      full_name: fullName,
      status: 'active'
    });
    logInfo('SuperAdmin created', { email, fullName });
  }

  // ── Print credentials once. Loud framing so it's obvious in a scrollback. ──
  const banner = '═'.repeat(72);
  console.log('\n' + banner);
  console.log(isRotate ? '  SUPER-ADMIN PASSWORD ROTATED' : '  SUPER-ADMIN CREATED');
  console.log(banner);
  console.log(`  Email:     ${email}`);
  if (!isRotate) console.log(`  Name:      ${fullName}`);
  console.log(`  Password:  ${plaintextPassword}`);
  console.log(banner);
  console.log('  Save this password to your password manager NOW.');
  console.log('  It will not be shown again. There is no recovery flow.');
  console.log('  Login at: <FRONTEND_ORIGIN>/calcite-admin/login');
  console.log(banner + '\n');

  process.exit(0);
})().catch((err) => {
  logError('createSuperAdmin failed', err);
  console.error(err);
  process.exit(1);
});
