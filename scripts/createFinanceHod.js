/**
 * createFinanceHod.js
 * ===================
 * Creates a Finance Head of Department via the platform API
 * (POST /platform/board-members) — the same endpoint the Responsible People
 * / onboarding forms use. Sets a password so the person can log in immediately.
 *
 * Usage (PowerShell):
 *   $env:WF_EMAIL="zf12811@gmail.com"; $env:WF_PASSWORD="Password123!"; `
 *   node scripts/createFinanceHod.js
 *
 * Optional env: WF_API_BASE, WF_OTP (default 1743).
 * Requires Node 18+ (global fetch).
 */

const API_BASE = process.env.WF_API_BASE || 'https://charitycompliance-backend.onrender.com/api/v1';
const EMAIL = process.env.WF_EMAIL;
const PASSWORD = process.env.WF_PASSWORD;
const OTP = process.env.WF_OTP || '1743';

if (!EMAIL || !PASSWORD) { console.error('Set WF_EMAIL and WF_PASSWORD.'); process.exit(1); }

// The person to create.
const PERSON = {
  title: 'Ms',
  given_names: 'Angela',
  family_name: 'Martin',
  email: 'angela.martin@yopmail.com',
  password: 'Stewardex@123',
  date_of_birth: '1985-06-15',
  licence_number: 'DLANGELA01',
  address: { line1: '10 Collins Street', suburb: 'Melbourne', state: 'VIC', postcode: '3000' },
};

async function api(path, { method = 'GET', body, token, orgId } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers['x-org-id'] = orgId;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function login() {
  const r = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.success) throw new Error(`Login failed (${r.status}): ${JSON.stringify(r.json?.error || r.json)}`);
  const d = r.json.data;
  if (d.needs_otp) {
    const v = await api('/auth/otp/verify', { method: 'POST', body: { userId: d.user_id, code: OTP, orgId: d.orgId } });
    if (v.status !== 200 || !v.json?.success) throw new Error(`OTP failed (${v.status})`);
    return { token: v.json.data.token, orgId: v.json.data.orgId };
  }
  return { token: d.token, orgId: d.orgId };
}

(async () => {
  console.log(`Logging in as ${EMAIL} ...`);
  const { token, orgId } = await login();
  console.log(`Authenticated. orgId=${orgId}`);

  const dr = await api('/platform/board-members/departments-roles', { token, orgId });
  const depts = dr.json?.data ?? dr.json ?? [];
  const finance = depts.find((d) => String(d.name).toLowerCase() === 'finance');
  if (!finance) throw new Error(`No "Finance" department found. Departments: ${depts.map((d) => d.name).join(', ')}`);

  const roles = finance.roles || [];
  if (!roles.length) throw new Error('Finance department has no positions.');
  // Prefer an unassigned position; otherwise take the first.
  const pos = roles.find((r) => (r.assignee_count || 0) === 0) || roles[0];
  console.log(`Finance department: ${roles.length} positions. Assigning HOD to: ${pos.name}`);

  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    title: PERSON.title,
    given_names: PERSON.given_names,
    family_name: PERSON.family_name,
    email: PERSON.email,
    phone: '',
    date_of_birth: PERSON.date_of_birth,
    department: finance.name,
    position: pos.name,
    position_id: pos.id,
    appointment_date: today,
    residential_address: PERSON.address,
    identification: { licence: { number: PERSON.licence_number } },
    is_head_of_department: true,
    is_board_member: false,
    system_access: true,
    invite: false,
    password: PERSON.password,
  };

  const r = await api('/platform/board-members', { method: 'POST', body: payload, token, orgId });
  if (r.status === 201 || r.json?.success) {
    const bm = r.json?.data || {};
    console.log(`\n+ Created Finance HOD: ${PERSON.given_names} ${PERSON.family_name}`);
    console.log(`  email: ${PERSON.email}  password: ${PERSON.password}`);
    console.log(`  department: ${finance.name}  position: ${pos.name}  head_of_department: true`);
    console.log(`  boardMemberId: ${bm._id || bm.id || '(n/a)'}`);
    process.exit(0);
  }
  const msg = r.json?.error?.message || r.json?.message || `HTTP ${r.status}`;
  const details = r.json?.error?.details ? ' :: ' + JSON.stringify(r.json.error.details) : '';
  console.error(`x Failed to create HOD: ${msg}${details}`);
  process.exit(2);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
