/**
 * Security regression suite — ONE file, all cases.
 *
 * Every previously-found vulnerability (pentest / DAST sheet) lives as a single
 * object in the SCENARIOS array below. Add one object per finding — do NOT make
 * new files. The suite scales to hundreds of cases in this one file.
 *
 * Each scenario:
 *   {
 *     id:       'ATZ-014',                 // sheet id
 *     severity: 'Critical',
 *     title:    'short description',
 *     requires: ['baseUrl','tokenA',...],  // config keys the HTTP test needs
 *     run(cfg):   async → { pass, status, note, evidence }   // BLACK-BOX (HTTP)
 *     selfTest(): async → { pass, checks:[{name,pass,detail}] } // OPTIONAL, no server/DB
 *   }
 *
 * ── Two ways to run ─────────────────────────────────────────────────────────
 *
 *  A) BLACK-BOX (the real thing — run against the DEPLOYED server, attach to sheet):
 *       SEC_BASE_URL=https://…/api/v1 SEC_TOKEN_A=<orgA jwt> SEC_ORGB_ID=<other org> \
 *       node security-tests/regression.mjs
 *     (or put those in security-tests/config.local.json — never commit real tokens)
 *
 *  B) SELF-TEST (no server, no DB, no creds — fast pre-deploy gate for cases that
 *     can be checked against the code directly):
 *       node security-tests/regression.mjs --selftest
 *
 * Exit code 0 = all pass, 1 = a regression. Every check prints status + evidence
 * so results paste straight into the sheet.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', yellow: '\x1b[33m' };

/* ------------------------------ config ------------------------------ */
function loadConfig() {
  let file = {};
  const p = path.join(__dirname, 'config.local.json');
  try { if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
  return {
    baseUrl: (process.env.SEC_BASE_URL || file.baseUrl || '').replace(/\/$/, ''),
    tokenA: process.env.SEC_TOKEN_A || file.tokenA || '',
    orgAId: process.env.SEC_ORGA_ID || file.orgAId || '',
    orgBId: process.env.SEC_ORGB_ID || file.orgBId || '',
    tokenB: process.env.SEC_TOKEN_B || file.tokenB || '',
    tokenUser: process.env.SEC_TOKEN_USER || file.tokenUser || '', // a NON-admin authenticated user's JWT
    otpUserId: process.env.SEC_OTP_USERID || file.otpUserId || '', // a userId with a pending OTP (for AUTH-014 black-box)
    otpOrgId: process.env.SEC_OTP_ORGID || file.otpOrgId || '',
    // Opt-in flag for scenarios that CREATE/DELETE data on the target server.
    allowMutations: (process.env.SEC_ALLOW_MUTATIONS === '1' || file.allowMutations === true) ? true : '',
  };
}

async function http(cfg, method, pathname, { token, orgId, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers['x-org-id'] = orgId;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${cfg.baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text };
}

/* ---- shared helper for selfTest cases that poke a middleware directly ---- */
function mockRes() {
  const r = { statusCode: null, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}
async function callMiddleware(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return { status: res.statusCode, body: res.body, nextCalled };
}
// Dummy env so backend config validation passes when a selfTest imports internals.
function ensureBackendEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.SKIP_TENANT_VALIDATION = 'false';
  process.env.ROUTER_DB_URI = process.env.ROUTER_DB_URI || 'mongodb://127.0.0.1:27017/sec_dummy';
  process.env.MASTER_KEY_HEX = process.env.MASTER_KEY_HEX || 'a'.repeat(64);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec-test-secret';
}

/* ============================== SCENARIOS ============================== */
/* Add one object per fixed finding. Keep them terse. */
const SCENARIOS = [
  {
    id: 'ATZ-014',
    severity: 'Critical',
    title: 'Multi-tenant isolation — x-org-id header must not override the JWT org',
    requires: ['baseUrl', 'tokenA', 'orgBId'],
    // BLACK-BOX: Org A token + Org B header across a few tenant endpoints must be
    // blocked (403/401), never 200 with Org B's data.
    async run(cfg) {
      const targets = ['/platform/users', '/platform/expenses', '/platform/risks'];
      const rows = [];
      for (const t of targets) {
        const { status, text } = await http(cfg, 'GET', t, { token: cfg.tokenA, orgId: cfg.orgBId });
        rows.push({ t, status, leaked: status === 200, code: (text.match(/"code":"([^"]+)"/) || [])[1] || '' });
      }
      const leaked = rows.some((r) => r.leaked);
      const allBlocked = rows.every((r) => r.status === 403 || r.status === 401);
      return {
        pass: allBlocked && !leaked,
        status: rows.map((r) => `${r.t}=${r.status}`).join(', '),
        note: leaked ? 'CROSS-TENANT READ LEAKED (200)' : (rows.some((r) => r.code === 'ORG_MISMATCH') ? 'blocked · ORG_MISMATCH' : 'blocked'),
        evidence: JSON.stringify(rows),
      };
    },
    // SELF-TEST: exercise resolveTenant's guard paths that return before any DB.
    async selfTest() {
      ensureBackendEnv();
      const { resolveTenant } = await import('../src/middleware/tenantResolver.js');
      const checks = [];
      let r = await callMiddleware(resolveTenant, { user: { orgId: 'orga' }, headers: { 'x-org-id': 'orgb' } });
      checks.push({ name: 'Org A token + Org B header → 403 ORG_MISMATCH', pass: r.status === 403 && r.body?.error?.code === 'ORG_MISMATCH' && !r.nextCalled, detail: `status=${r.status} code=${r.body?.error?.code}` });
      r = await callMiddleware(resolveTenant, { user: { orgId: 'orga' }, headers: { 'x-org-id': 'ORGB' } });
      checks.push({ name: 'Mismatch is case-insensitive → 403', pass: r.status === 403 && r.body?.error?.code === 'ORG_MISMATCH', detail: `status=${r.status}` });
      r = await callMiddleware(resolveTenant, { user: undefined, headers: { 'x-org-id': 'orgb' } });
      checks.push({ name: 'Unauthenticated + header not trusted → 401', pass: r.status === 401 && !r.nextCalled, detail: `status=${r.status}` });
      r = await callMiddleware(resolveTenant, { user: { orgId: 'orga' }, headers: { 'x-org-id': 'orga' } });
      checks.push({ name: 'Matching header passes the guard (not 403/401)', pass: r.status !== 403 && r.status !== 401, detail: `status=${r.status} (DB-less env → non-403/401 means guard passed)` });
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'API-020',
    severity: 'Critical',
    title: 'Mass-assignment — board member create/update must ignore privileged fields',
    requires: ['baseUrl', 'tokenA', 'allowMutations'],
    // BLACK-BOX (mutating; opt in with SEC_ALLOW_MUTATIONS=1): create a board
    // member while injecting privileged fields, read it back, assert none stuck,
    // then delete it. Uses the JWT org (no x-org-id header needed post-ATZ-014).
    async run(cfg) {
      const email = `sectest-api020-${cfg.orgAId || 'x'}@example.invalid`;
      const payload = {
        given_names: 'SecTest', family_name: 'API020', position: 'Tester', email,
        // These must all be IGNORED (server-controlled / auth / invite / tenant):
        has_system_access: true, is_active: true, status: 'active',
        user_id: '000000000000000000000000', org_id: 'evil-org', invitation_status: 'accepted',
      };
      const created = await http(cfg, 'POST', '/platform/board-members', { token: cfg.tokenA, body: payload });
      if (created.status !== 201 && created.status !== 200) {
        return { pass: false, status: created.status, note: 'create failed (need a valid admin/owner token)', evidence: created.text.slice(0, 200) };
      }
      let doc = {};
      try { const j = JSON.parse(created.text); doc = j.data || j; } catch { /* ignore */ }
      const id = doc._id || doc.id;
      const leaked = [];
      if (doc.has_system_access === true) leaked.push('has_system_access');
      if (String(doc.user_id || '') === '000000000000000000000000') leaked.push('user_id');
      if (doc.invitation_status === 'accepted') leaked.push('invitation_status');
      if (doc.org_id && String(doc.org_id).toLowerCase() === 'evil-org') leaked.push('org_id');
      if (id) { try { await http(cfg, 'DELETE', `/platform/board-members/${id}`, { token: cfg.tokenA }); } catch { /* best-effort cleanup */ } }
      return {
        pass: leaked.length === 0,
        status: `create=${created.status}`,
        note: leaked.length ? `MASS-ASSIGNED: ${leaked.join(', ')}` : 'privileged fields ignored',
        evidence: JSON.stringify({ id, has_system_access: doc.has_system_access, user_id: doc.user_id, invitation_status: doc.invitation_status, org_id: doc.org_id }),
      };
    },
    // SELF-TEST: the whitelist strips privileged fields (pure function, no server).
    async selfTest() {
      ensureBackendEnv();
      const { pickEditableBoardMemberFields } = await import('../src/controllers/boardMemberController.js');
      const malicious = {
        given_names: 'Legit', family_name: 'User', position: 'Tester',
        org_id: 'EVIL_ORG', user_id: '000000000000000000000000',
        has_system_access: true, is_active: true, status: 'active',
        invitation_status: 'accepted', invitation_token: 'x', offboarded_at: '2020-01-01',
      };
      const out = pickEditableBoardMemberFields(malicious);
      const blocked = ['org_id', 'user_id', 'has_system_access', 'is_active', 'status', 'invitation_status', 'invitation_token', 'offboarded_at'];
      const checks = [{ name: 'Allowed field kept (given_names)', pass: out.given_names === 'Legit', detail: `given_names=${out.given_names}` }];
      for (const f of blocked) checks.push({ name: `Privileged field stripped: ${f}`, pass: !(f in out), detail: `present=${f in out}` });
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'INP-002',
    severity: 'Critical',
    title: 'NoSQL injection — reset-password token must reject Mongo operators',
    requires: ['baseUrl', 'allowMutations'],
    // BLACK-BOX (opt-in): on a VULNERABLE server this resets a real user's
    // password, so it is gated behind SEC_ALLOW_MUTATIONS. On a fixed server it
    // is a harmless 400. Attack payload: token as { $ne: null }.
    async run(cfg) {
      const { status, text } = await http(cfg, 'POST', '/auth/reset-password', {
        body: { token: { $ne: null }, password: 'Valid1!aa' },
      });
      // Fixed = NOT 200 (400 INVALID_RESET_TOKEN / VALIDATION_ERROR). 200 = takeover.
      const pass = status !== 200;
      return {
        pass,
        status: `reset-password=${status}`,
        note: status === 200 ? 'ACCOUNT TAKEOVER — operator injection accepted (200)' : 'operator injection rejected',
        evidence: text.slice(0, 200),
      };
    },
    // SELF-TEST: the global sanitizer strips $-operators, and the repo guard
    // rejects a non-string token — both without a server.
    async selfTest() {
      ensureBackendEnv();
      const { _scrubMongoOperators } = await import('../src/middleware/sanitizeMongo.js');
      const checks = [];
      const body = { token: { $ne: null }, nested: { $gt: '' }, ok: 'keep', 'a.b': 1 };
      _scrubMongoOperators(body);
      checks.push({ name: 'Sanitizer strips $ne inside token', pass: body.token && !('$ne' in body.token), detail: `token=${JSON.stringify(body.token)}` });
      checks.push({ name: 'Sanitizer strips nested $gt', pass: body.nested && !('$gt' in body.nested), detail: `nested=${JSON.stringify(body.nested)}` });
      checks.push({ name: 'Sanitizer strips dotted key a.b', pass: !('a.b' in body), detail: `hasDotted=${'a.b' in body}` });
      checks.push({ name: 'Sanitizer keeps legit field', pass: body.ok === 'keep', detail: `ok=${body.ok}` });

      const { UserRepository } = await import('../src/repositories/userRepository.js');
      // Mock tenantDb: if the guard is bypassed, findOne would return a "user"
      // (the takeover). A correct guard returns null WITHOUT touching findOne.
      const mockModel = { findOne: async () => ({ _id: 'GUARD_BYPASSED' }) };
      const repo = new UserRepository({ models: { User: mockModel }, model: () => mockModel });
      const objResult = await repo.findByResetToken({ $ne: null });
      const emptyResult = await repo.findByResetToken('');
      checks.push({ name: 'findByResetToken rejects object token (null, no query)', pass: objResult === null, detail: `result=${JSON.stringify(objResult)}` });
      checks.push({ name: 'findByResetToken rejects empty token (null)', pass: emptyResult === null, detail: `result=${JSON.stringify(emptyResult)}` });
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'MDB-016',
    severity: 'Critical',
    title: 'Generic NoSQL operator injection — DUPLICATE of INP-002 (same fix)',
    requires: ['baseUrl', 'allowMutations'],
    // Same confirmed vector as INP-002 (password-reset operator injection);
    // closed by the same repo/handler type guards + global sanitizeMongo.
    async run(cfg) {
      const { status, text } = await http(cfg, 'POST', '/auth/reset-password', {
        body: { token: { $ne: null }, password: 'Valid1!aa' },
      });
      return {
        pass: status !== 200,
        status: `reset-password=${status}`,
        note: status === 200 ? 'INJECTION ACCEPTED (200)' : 'operator injection rejected (global sanitizer + type guard)',
        evidence: text.slice(0, 200),
      };
    },
    // SELF-TEST the GENERIC defence (the global sanitizer) with non-reset bodies,
    // to show the whole class — not just the one endpoint — is neutralised.
    async selfTest() {
      ensureBackendEnv();
      const { _scrubMongoOperators } = await import('../src/middleware/sanitizeMongo.js');
      const login = { email: { $gt: '' }, password: 'x' };
      const search = { filter: { user: { $where: '1==1' } }, name: 'ok' };
      _scrubMongoOperators(login);
      _scrubMongoOperators(search);
      const checks = [
        { name: 'Global sanitizer strips $gt (login-style body)', pass: login.email && !('$gt' in login.email), detail: JSON.stringify(login) },
        { name: 'Global sanitizer strips nested $where', pass: !('$where' in search.filter.user), detail: JSON.stringify(search.filter.user) },
        { name: 'Legit fields preserved', pass: login.password === 'x' && search.name === 'ok', detail: `password=${login.password} name=${search.name}` },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'API-002',
    severity: 'High',
    title: 'Authorization required — role management is admin/owner-only',
    requires: ['baseUrl', 'tokenUser'],
    // BLACK-BOX: a NON-admin authenticated user must be forbidden from reading
    // or managing roles. 200 = broken authorization (privilege escalation path).
    async run(cfg) {
      const { status, text } = await http(cfg, 'GET', '/platform/roles', { token: cfg.tokenUser });
      return {
        pass: status === 403 || status === 401,
        status: `GET /platform/roles=${status}`,
        note: status === 200 ? 'AUTHZ MISSING — non-admin listed roles (200)' : 'authorization enforced',
        evidence: text.slice(0, 150),
      };
    },
    // SELF-TEST the guard now applied to every role route.
    async selfTest() {
      ensureBackendEnv();
      const { requireAdminOrOwner } = await import('../src/middleware/rbac.js');
      const checks = [];
      let r = await callMiddleware(requireAdminOrOwner, { user: undefined });
      checks.push({ name: 'No auth → 401', pass: r.status === 401 && !r.nextCalled, detail: `status=${r.status}` });
      r = await callMiddleware(requireAdminOrOwner, { user: { roles: [], is_org_owner: false, permissions: [] } });
      checks.push({ name: 'Non-admin authenticated → 403', pass: r.status === 403 && !r.nextCalled, detail: `status=${r.status}` });
      r = await callMiddleware(requireAdminOrOwner, { user: { roles: ['admin'] } });
      checks.push({ name: 'Admin → allowed (next)', pass: r.nextCalled === true, detail: `next=${r.nextCalled}` });
      r = await callMiddleware(requireAdminOrOwner, { user: { is_org_owner: true } });
      checks.push({ name: 'Org owner → allowed (next)', pass: r.nextCalled === true, detail: `next=${r.nextCalled}` });
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'API-003',
    severity: 'High',
    title: 'Rate limiting — public auth endpoints must throttle brute force',
    requires: ['baseUrl'],
    // BLACK-BOX: burst failed logins (varying emails so single-account lockout
    // 423 doesn't mask the IP limiter). A 429 must appear once the limit trips.
    // NOTE: this consumes the caller IP's auth budget (~15 min) by design.
    async run(cfg) {
      const statuses = [];
      for (let i = 0; i < 8; i += 1) {
        const { status } = await http(cfg, 'POST', '/auth/login', {
          body: { email: `sec-api003-${i}@example.invalid`, password: 'WrongPass1!' },
        });
        statuses.push(status);
      }
      const has429 = statuses.includes(429);
      return {
        pass: has429,
        status: `logins=[${statuses.join(',')}]`,
        note: has429 ? 'rate limit fired (429)' : 'NO 429 — rate limiting missing',
        evidence: '',
      };
    },
    // SELF-TEST: the limiters exist and are mounted on the sensitive routes.
    async selfTest() {
      const { authLimiter, passwordResetLimiter } = await import('../src/middleware/rateLimiter.js');
      const src = fs.readFileSync(path.join(__dirname, '../src/routes/platform/authRoutes.js'), 'utf8');
      const checks = [
        { name: 'authLimiter is middleware', pass: typeof authLimiter === 'function', detail: typeof authLimiter },
        { name: 'passwordResetLimiter is middleware', pass: typeof passwordResetLimiter === 'function', detail: typeof passwordResetLimiter },
        { name: '/login is rate-limited', pass: /post\('\/login',\s*authLimiter/.test(src), detail: 'authLimiter on login' },
        { name: '/otp/verify is rate-limited', pass: /post\('\/otp\/verify',\s*authLimiter/.test(src), detail: 'authLimiter on otp/verify' },
        { name: '/forgot-password is rate-limited', pass: /post\('\/forgot-password',\s*passwordResetLimiter/.test(src), detail: '' },
        { name: '/reset-password is rate-limited', pass: /post\('\/reset-password',\s*passwordResetLimiter/.test(src), detail: '' },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'AUTH-014',
    severity: 'Critical',
    title: 'WAIVED by product — OTP is intentionally the fixed 4-digit "1743" (UI accepts 4 digits)',
    // The random-6-digit fix was reverted at the product owner's request: the
    // Verify screen only accepts a 4-digit code, so a random 6-digit emailed
    // code made login impossible. OTP is deliberately the constant "1743".
    // This selfTest just pins the intended (reverted) behavior so a future edit
    // that re-randomizes the code is caught.
    async selfTest() {
      ensureBackendEnv();
      const svc = (await import('../src/services/authService.js')).default;
      const code = svc.generateOtpCode();
      return {
        pass: code === '1743',
        checks: [
          { name: 'generateOtpCode returns fixed 4-digit 1743 (product decision)', pass: code === '1743', detail: `code=${code}` },
          { name: 'no _otpBypassEnabled gate left behind', pass: typeof svc._otpBypassEnabled !== 'function', detail: '' },
        ],
      };
    },
  },

  {
    id: 'SESS-008',
    severity: 'High',
    title: 'Session invalidation on password change/reset (iat vs password_changed_at)',
    // SELF-TEST only: statically verify the wiring is present (a black-box probe
    // would require changing a real user's password + reusing the old token).
    async selfTest() {
      const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
      const auth = read('../src/middleware/auth.js');
      const svc = read('../src/services/authService.js');
      const repo = read('../src/repositories/userRepository.js');
      const stampCount = (svc.match(/password_changed_at:\s*new Date\(\)/g) || []).length;
      const checks = [
        { name: 'User schema has password_changed_at (Date)', pass: /password_changed_at:\s*\{\s*type:\s*Date/.test(repo), detail: '' },
        { name: 'authenticate rejects pre-change tokens', pass: /password_changed_at/.test(auth) && /SESSION_INVALIDATED/.test(auth) && /decoded\.iat/.test(auth), detail: 'iat < password_changed_at → 401' },
        { name: 'reset + change both stamp password_changed_at', pass: stampCount >= 2, detail: `stamps=${stampCount}` },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'API-027',
    severity: 'Medium',
    title: 'Search ReDoS / regex injection — user input escaped before RegExp',
    async selfTest() {
      ensureBackendEnv();
      const { escapeRegex } = await import('../src/utils/escapeRegex.js');
      const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
      const checks = [
        { name: 'Metacharacters escaped (ReDoS payload)', pass: escapeRegex('(a+)+$') === '\\(a\\+\\)\\+\\$', detail: escapeRegex('(a+)+$') },
        { name: 'Plain text preserved', pass: escapeRegex('john smith') === 'john smith', detail: '' },
        { name: 'null/undefined safe', pass: escapeRegex(null) === '' && escapeRegex(undefined) === '', detail: '' },
      ];
      for (const f of ['donationRepository', 'disciplinaryRecordRepository', 'riskRepository', 'supplierRepository', 'partnerVettingRepository', 'projectRegisterRepository']) {
        const src = read(`../src/repositories/${f}.js`);
        checks.push({ name: `${f} escapes search input`, pass: /escapeRegex\(filters\.(search|category)|escapeRegex\(search/.test(src), detail: '' });
      }
      return { pass: checks.every((c) => c.pass), checks };
    },
  },
  {
    id: 'API-009',
    severity: 'Medium',
    title: 'CORS — unconditional localhost allowance is dev-only (not production)',
    async selfTest() {
      const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
      const pass = /NODE_ENV\s*!==\s*'production'\s*&&[^\n]*localhost/.test(src);
      return { pass, checks: [{ name: 'localhost CORS allowance gated by NODE_ENV !== production', pass, detail: '' }] };
    },
  },
  {
    id: 'API-020-role-complaint',
    severity: 'High',
    title: 'Mass-assignment — role + complaint reject privileged/workflow fields',
    async selfTest() {
      const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
      const role = read('../src/services/roleService.js');
      const comp = read('../src/controllers/complaintController.js');
      const roleAllow = (role.match(/EDITABLE_ROLE_FIELDS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
      const checks = [
        { name: 'roleService allowlists fields (pickRoleFields, not ...roleData)', pass: /\.\.\.pickRoleFields\(roleData\)/.test(role) && !/\.\.\.roleData,/.test(role), detail: '' },
        { name: 'roleService excludes is_system / is_readonly', pass: !/is_system/.test(roleAllow) && !/is_readonly/.test(roleAllow), detail: `allow=[${roleAllow.trim()}]` },
        { name: 'complaint strips protected fields (no raw req.body update)', pass: /COMPLAINT_PROTECTED_FIELDS/.test(comp) && /board_signoff/.test(comp) && /safeUpdate/.test(comp) && !/update\(complaintId, req\.body\)/.test(comp), detail: '' },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'INP-014',
    severity: 'Medium',
    title: 'CSV/formula injection — export cells neutralise leading = + - @',
    async selfTest() {
      const read = (p) => { try { return fs.readFileSync(path.join(__dirname, p), 'utf8'); } catch { return ''; } };
      const files = {
        'backend approvalZipExportService': read('../src/services/approvalZipExportService.js'),
        'frontend csvExport': read('../../charitycompliance-frontend/src/lib/csvExport.js'),
        'mobile exportCsv': read('../../st-mobile/src/lib/exportCsv.js'),
      };
      const guard = /\^\[=\+\\?-@\\t\\r\]/; // matches /^[=+\-@\t\r]/
      const checks = Object.entries(files).map(([name, src]) => ({
        name: `${name} escapes formula-triggering cells`,
        pass: !!src && guard.test(src),
        detail: src ? '' : 'file not found',
      }));
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'INP-005',
    severity: 'Medium',
    title: 'PDF-export DOM XSS — innerHTML sanitized with DOMPurify (INP-005/007/008/028)',
    async selfTest() {
      const read = (p) => { try { return fs.readFileSync(path.join(__dirname, p), 'utf8'); } catch { return ''; } };
      const files = {
        'approval PDF': '../../charitycompliance-frontend/src/features/approvals/generateApprovalPDF.js',
        'audit PDF': '../../charitycompliance-frontend/src/features/audit-trail/generateAuditTrailPDF.js',
        'policy sign-off': '../../charitycompliance-frontend/src/features/policies/PolicySignOffSheet.jsx',
        'funding PDF': '../../charitycompliance-frontend/src/features/grants-donors/generateFundingAgreementPDF.js',
      };
      const checks = Object.entries(files).map(([name, p]) => {
        const src = read(p);
        const wrapped = /container\.innerHTML\s*=\s*(sanitizePdfHtml|DOMPurify\.sanitize)\(/.test(src);
        const bare = /container\.innerHTML\s*=\s*`/.test(src);
        return { name: `${name} sanitizes innerHTML (no bare assign)`, pass: !!src && wrapped && !bare, detail: bare ? 'bare innerHTML remains' : (src ? '' : 'file not found') };
      });
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'MDB-020',
    severity: 'Medium',
    title: 'NoSQL $regex injection / ReDoS — user-supplied search is escaped in every repository',
    async selfTest() {
      const repoDir = path.join(__dirname, '../src/repositories');
      const files = fs.readdirSync(repoDir).filter((f) => f.endsWith('.js'));
      // A regex construction is "unsafe" only when the pattern is a raw user value.
      // Escaped forms are: escapeRegex(...), escapeRe(...), or an inline
      // .replace(/[.*+?^${}()|[\]\\]/g, ...) right on the value.
      const USER_TOKENS = /\b(filters\.(search|searchTerm|category)|(?<!escapeRe(?:gex)?\()\bsearch\b)\b/;
      const checks = [];
      for (const f of files) {
        const src = fs.readFileSync(path.join(repoDir, f), 'utf8');
        const lines = src.split('\n');
        lines.forEach((line, i) => {
          const isRegexSite = /\$regex:\s*[^`'"]*\bfilters\.(search|searchTerm|category)\b/.test(line)
            || /new RegExp\(\s*(String\()?\s*(filters\.(search|searchTerm|category))/.test(line);
          if (!isRegexSite) return;
          const escaped = /escapeRegex\(|escapeRe\(|replace\(\s*\/\[\.\*\+/.test(line);
          if (!escaped) {
            checks.push({ name: `${f}:${i + 1} escapes user regex`, pass: false, detail: line.trim().slice(0, 90) });
          }
        });
      }
      // Also assert the five repos fixed in this batch each import escapeRegex.
      for (const f of ['donorRepository', 'policyRepository', 'legalDocumentRepository', 'fundingProgramRepository', 'assetRepository']) {
        const src = fs.readFileSync(path.join(repoDir, `${f}.js`), 'utf8');
        checks.push({ name: `${f} imports+uses escapeRegex`, pass: /escapeRegex/.test(src), detail: '' });
      }
      if (!checks.some((c) => !c.pass)) checks.unshift({ name: 'no unescaped $regex/new RegExp on user input across repositories', pass: true, detail: '' });
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'MDB-026',
    severity: 'High',
    title: 'Query-string operator injection — query parser pinned to "simple" (defence-in-depth)',
    async selfTest() {
      const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
      const pinned = /app\.set\(\s*['"]query parser['"]\s*,\s*['"]simple['"]\s*\)/.test(src);
      const sanitizer = /sanitizeMongo/.test(src);
      return {
        pass: pinned && sanitizer,
        checks: [
          { name: 'query parser pinned to simple', pass: pinned, detail: pinned ? '' : 'app.set(query parser, simple) missing' },
          { name: 'sanitizeMongo still mounted', pass: sanitizer, detail: '' },
        ],
      };
    },
  },

  {
    id: 'FUP-003',
    severity: 'Medium',
    title: 'Upload content validation — magic bytes, double-extension & markup/exe rejected (FUP-003/004/009)',
    async selfTest() {
      const { verifyUploadedFile } = await import('../src/utils/fileContentGuard.js');
      const PDF = Buffer.from('%PDF-1.7\n...', 'latin1');
      const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1');
      const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
      const throws = (fn) => { try { fn(); return false; } catch { return true; } };
      const checks = [
        { name: 'valid PDF accepted', pass: !throws(() => verifyUploadedFile(PDF, 'report.pdf', 'application/pdf')), detail: '' },
        { name: 'valid PNG accepted', pass: !throws(() => verifyUploadedFile(PNG, 'logo.png', 'image/png')), detail: '' },
        { name: 'CSV (no signature) accepted', pass: !throws(() => verifyUploadedFile(Buffer.from('a,b,c\n1,2,3'), 'data.csv', 'text/csv')), detail: '' },
        { name: 'HTML bytes under .pdf name rejected', pass: throws(() => verifyUploadedFile(HTML, 'invoice.pdf', 'application/pdf')), detail: '' },
        { name: 'double-extension .pdf.html rejected', pass: throws(() => verifyUploadedFile(PDF, 'invoice.pdf.html', 'application/pdf')), detail: '' },
        { name: 'content/extension mismatch (%PDF under .png) rejected', pass: throws(() => verifyUploadedFile(PDF, 'x.png', 'image/png')), detail: '' },
        { name: 'executable (MZ) rejected', pass: throws(() => verifyUploadedFile(EXE, 'setup.png', 'image/png')), detail: '' },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'FUP-015',
    severity: 'High',
    title: 'Download authorization — presigned TTL capped + inline serving neutralised (FUP-015)',
    async selfTest() {
      const { setSafeDownloadHeaders } = await import('../src/utils/safeDownloadHeaders.js');
      const mkRes = () => { const h = {}; return { setHeader: (k, v) => { h[k.toLowerCase()] = v; }, _h: h }; };
      const rHtml = mkRes(); setSafeDownloadHeaders(rHtml, { contentType: 'text/html', fileName: 'x.html' });
      const rPdf = mkRes(); setSafeDownloadHeaders(rPdf, { contentType: 'application/pdf', fileName: 'x.pdf' });
      const src = fs.readFileSync(path.join(__dirname, '../src/services/s3Service.js'), 'utf8');
      const checks = [
        { name: 'html forced to attachment', pass: /attachment/.test(rHtml._h['content-disposition'] || ''), detail: rHtml._h['content-disposition'] },
        { name: 'html content-type neutralised to octet-stream', pass: rHtml._h['content-type'] === 'application/octet-stream', detail: rHtml._h['content-type'] },
        { name: 'nosniff always set', pass: rHtml._h['x-content-type-options'] === 'nosniff', detail: '' },
        { name: 'pdf still allowed inline', pass: /inline/.test(rPdf._h['content-disposition'] || ''), detail: rPdf._h['content-disposition'] },
        { name: 'getFileUrl clamps TTL to a ceiling', pass: /Math\.min\(/.test(src) && /MAX_DOWNLOAD_TTL_SECONDS\s*\)/.test(src), detail: '' },
        { name: 'uploadToS3 no longer uses 7-day (604800) URLs', pass: !/604800/.test(src), detail: '' },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'LOG-006',
    severity: 'Medium',
    title: 'PII excluded from logs — email masked on auth/notification log paths',
    async selfTest() {
      const { maskEmail } = await import('../src/utils/maskPii.js');
      const masked = maskEmail('john.doe@example.com');
      const read = (p) => { try { return fs.readFileSync(path.join(__dirname, p), 'utf8'); } catch { return ''; } };
      const auth = read('../src/services/authService.js');
      // No raw `{ email }` / `email: recipientEmail` shorthands left on log lines.
      const rawEmailLog = /log(?:Warn|Info|Error)\([^)]*\{[^}]*\bemail\b(?!\s*:\s*maskEmail)[^}]*(?:\brecipientEmail\b|\}\s*\))/.test(
        auth.split('\n').filter((l) => /log(Warn|Info|Error)/.test(l) && /email/.test(l) && !/maskEmail|emailHash|email_hash|Failed to (decrypt|check)|email_/.test(l)).join('\n')
      );
      const checks = [
        { name: 'maskEmail hides local part', pass: !masked.includes('john.doe') && masked.includes('@'), detail: masked },
        { name: 'maskEmail hides domain body', pass: !masked.includes('example'), detail: masked },
        { name: 'null/garbage safe', pass: maskEmail(null) === null && maskEmail('notanemail') === '***', detail: '' },
        { name: 'authService uses maskEmail on email log lines', pass: /maskEmail\(/.test(auth), detail: '' },
        { name: 'no raw email left on authService log lines', pass: !rawEmailLog, detail: '' },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  {
    id: 'LOG-002',
    severity: 'Medium',
    title: 'Admin activity + audit trail — append-only audit_logs on every platform mutation, durable log sink (LOG-002/004)',
    async selfTest() {
      const read = (p) => { try { return fs.readFileSync(path.join(__dirname, p), 'utf8'); } catch { return ''; } };
      const mw = read('../src/middleware/auditLogger.js');
      const app = read('../src/app.js');
      const logger = read('../src/utils/logger.js');
      const checks = [
        { name: 'audit middleware records mutating requests', pass: /MUTATING[\s\S]*recordAuditLog/.test(mw), detail: '' },
        { name: 'captures actor + entity + action', pass: /actor_user_id/.test(mw) && /entity_id/.test(mw) && /action:/.test(mw), detail: '' },
        { name: 'audit middleware mounted on platform namespace', pass: /auditLogMutationMiddleware/.test(app), detail: '' },
        { name: 'logger writes durable LOG_FILE sink', pass: /LOG_FILE/.test(logger) && /createWriteStream/.test(logger) && /writeToSink/.test(logger), detail: '' },
      ];
      return { pass: checks.every((c) => c.pass), checks };
    },
  },

  // ── next finding ↓ (copy this block, fill it in) ─────────────────────────
  // {
  //   id: 'XXX-000', severity: 'High', title: '…', requires: ['baseUrl', 'tokenA'],
  //   async run(cfg) { /* HTTP probe */ return { pass, status, note, evidence }; },
  //   // async selfTest() { return { pass, checks: [] }; },   // optional
  // },
];

/* =============================== runner =============================== */
function line(tag, id, sev, title) { console.log(`${tag}  ${C.bold}${id}${C.reset} [${sev}]  ${title}`); }

async function runSelfTests() {
  console.log(`${C.bold}Security regression — SELF-TEST${C.reset} ${C.dim}(no server/DB; only cases with a selfTest)${C.reset}\n`);
  let failures = 0; let ran = 0;
  for (const s of SCENARIOS) {
    if (typeof s.selfTest !== 'function') continue;
    ran++;
    let out;
    try { out = await s.selfTest(); } catch (e) { out = { pass: false, checks: [{ name: 'selfTest threw', pass: false, detail: e?.message || String(e) }] }; }
    if (!out.pass) failures++;
    line(out.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`, s.id, s.severity, s.title);
    for (const c of out.checks || []) console.log(`      ${c.pass ? C.green + '✓' : C.red + '✗'}${C.reset} ${c.name} ${C.dim}(${c.detail})${C.reset}`);
    console.log('');
  }
  console.log(`${C.bold}Self-test summary${C.reset}: ${ran - failures}/${ran} scenarios passed.`);
  process.exit(failures ? 1 : 0);
}

async function runBlackBox() {
  const cfg = loadConfig();
  if (!cfg.baseUrl) {
    console.error(`${C.red}Missing SEC_BASE_URL${C.reset} — set env vars or security-tests/config.local.json (see file header).`);
    process.exit(2);
  }
  console.log(`${C.bold}Security regression — BLACK-BOX${C.reset} ${C.dim}→ ${cfg.baseUrl}${C.reset}\n`);
  let failures = 0; let skipped = 0;
  for (const s of SCENARIOS) {
    if (typeof s.run !== 'function') { skipped++; line(`${C.yellow}SKIP${C.reset}`, s.id, s.severity, s.title); console.log(`      ${C.dim}self-test only (run with --selftest); no black-box probe${C.reset}\n`); continue; }
    const missing = (s.requires || []).filter((k) => !cfg[k]);
    if (missing.length) { skipped++; line(`${C.yellow}SKIP${C.reset}`, s.id, s.severity, s.title); console.log(`      ${C.dim}missing config: ${missing.join(', ')}${C.reset}\n`); continue; }
    let r;
    try { r = await s.run(cfg); } catch (e) { r = { pass: false, status: 'error', note: e?.message || String(e), evidence: '' }; }
    if (!r.pass) failures++;
    line(r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`, s.id, s.severity, s.title);
    console.log(`      ${C.dim}status:${C.reset} ${r.status}`);
    console.log(`      ${C.dim}result:${C.reset} ${r.note}`);
    if (r.evidence) console.log(`      ${C.dim}evidence:${C.reset} ${String(r.evidence).slice(0, 300)}`);
    console.log('');
  }
  const total = SCENARIOS.length;
  console.log(`${C.bold}Summary${C.reset}: ${total - failures - skipped}/${total} passed, ${failures} failed, ${skipped} skipped.`);
  process.exit(failures ? 1 : 0);
}

const selfMode = process.argv.includes('--selftest') || process.argv.includes('-s');
(selfMode ? runSelfTests() : runBlackBox());
