/**
 * reactivateUser.js — undo an offboarding: reactivate a tenant user (login)
 * and, optionally, their soft-removed board-member record.
 *
 * Offboarding renames the email to offboarded+<ts>-<local>@offboarded.local and
 * sets status=inactive, locked=true; the board member is soft-removed
 * (user_id/position_id nulled, status='removed'). This restores the same
 * account (same _id, so existing links like pending approvals stay intact).
 *
 * Runs through the Mongoose model so the encryption plugin re-encrypts the
 * email and recomputes the `email_hash` blind index correctly (that hash is an
 * HMAC with the master key — it cannot be hand-typed).
 *
 * Requires the backend env (ROUTER_DB_URI + MASTER_KEY_HEX). Run from the
 * backend folder:
 *   node scripts/reactivateUser.js
 *
 * Override via env: REACT_ORG, REACT_USER_ID, REACT_EMAIL, REACT_PASSWORD,
 * REACT_FIRST, REACT_LAST, REACT_BM_ID (board member to reactivate),
 * REACT_POSITION_ID (position to relink).
 */

import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import { getTenantConnection } from '../src/db/connectionManager.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import dns from 'node:dns';

dotenv.config();

// Some local / VPN DNS resolvers refuse SRV lookups for mongodb+srv:// URIs
// (error: querySrv ECONNREFUSED). Prepend reliable public resolvers so the
// Atlas SRV/TXT records resolve.
try { dns.setServers(['1.1.1.1', '8.8.8.8', ...dns.getServers()]); } catch { /* ignore */ }

const ORG         = process.env.REACT_ORG || 'org_testing_v1';
const USER_ID     = process.env.REACT_USER_ID || '6a758eab32c70ee96d44a4a0';
const EMAIL       = process.env.REACT_EMAIL || 'kellykapoor@yopmail.com';
const PASSWORD    = process.env.REACT_PASSWORD || 'Stewardex@123';
const FIRST       = process.env.REACT_FIRST || 'Kelly';
const LAST        = process.env.REACT_LAST || 'Kapoor';
const BM_ID       = process.env.REACT_BM_ID || '';          // optional
const POSITION_ID = process.env.REACT_POSITION_ID || '';    // optional

(async () => {
  await connectRouterDB();
  const db = await getTenantConnection(ORG);

  // ── User (login) ──────────────────────────────────────────────────
  const userRepo = new UserRepository(db);
  const user = await userRepo.User.findById(USER_ID);
  if (!user) throw new Error(`User ${USER_ID} not found in org "${ORG}".`);

  user.email = EMAIL;              // plugin re-encrypts + recomputes email_hash
  user.first_name = FIRST;         // (were left intact by offboarding, reset anyway)
  user.last_name = LAST;
  user.status = 'active';
  user.locked = false;
  user.locked_until = null;
  user.failed_login_attempts = 0;
  user.mfa_enabled = false;
  user.mfa_secret = null;
  user.password_hash = await bcrypt.hash(PASSWORD, 12);   // cost 12, matches app
  user.password_changed_at = new Date();                  // invalidate old sessions
  await user.save();
  console.log(`Reactivated USER ${USER_ID}: ${EMAIL} — active, unlocked, password reset to "${PASSWORD}".`);

  // ── Board member (governance profile) — optional ──────────────────
  if (BM_ID) {
    const BoardMember = db.models.BoardMember
      || db.model('BoardMember', (await import('../src/db/schemas/platform/boardMemberSchema.js')).default);
    const bm = await BoardMember.findById(BM_ID);
    if (!bm) {
      console.warn(`Board member ${BM_ID} not found — skipped. (Re-add her via Responsible People instead.)`);
    } else {
      bm.user_id = USER_ID;
      bm.is_active = true;   // offboarding set this false; the permission
                            // resolver only sees is_active:true board members
      bm.status = 'active';
      bm.has_system_access = true;
      bm.invitation_status = 'accepted';
      bm.offboarded_at = null;
      if (POSITION_ID) bm.position_id = POSITION_ID;
      await bm.save();
      console.log(`Reactivated BOARD MEMBER ${BM_ID}${POSITION_ID ? ` (position ${POSITION_ID})` : ''}.`);
    }
  } else {
    console.log('No REACT_BM_ID given — user login restored; add her as a Responsible Person in the app, ' +
      'or re-run with REACT_BM_ID (and REACT_POSITION_ID) to reactivate her board-member record.');
  }

  await closeRouterDB();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
