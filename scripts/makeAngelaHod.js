/**
 * makeAngelaHod.js
 * ================
 * Makes Angela Martin the SOLE Head of the Finance department.
 *
 * HOD is resolved as: a board member with is_head_of_department=true whose
 * position sits in the department. There's no auto "demote others" on
 * create/update, so this script:
 *   1) ensures Angela has a Finance position + is_head_of_department=true
 *   2) demotes any OTHER Finance member currently flagged as head
 * via PUT /platform/board-members/:id.
 *
 * Usage: $env:WF_EMAIL="zf12811@gmail.com"; $env:WF_PASSWORD="Password123!"; node scripts/makeAngelaHod.js
 */

const API_BASE = process.env.WF_API_BASE || 'https://charitycompliance-backend.onrender.com/api/v1';
const EMAIL = process.env.WF_EMAIL;
const PASSWORD = process.env.WF_PASSWORD;
const OTP = process.env.WF_OTP || '1743';
const TARGET_EMAIL = 'angela.martin@yopmail.com';
const TARGET_NAME = 'angela martin';

if (!EMAIL || !PASSWORD) { console.error('Set WF_EMAIL and WF_PASSWORD.'); process.exit(1); }

async function api(path, { method = 'GET', body, token, orgId } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers['x-org-id'] = orgId;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function login() {
  const r = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.success) throw new Error(`Login failed (${r.status})`);
  const d = r.json.data;
  if (d.needs_otp) {
    const v = await api('/auth/otp/verify', { method: 'POST', body: { userId: d.user_id, code: OTP, orgId: d.orgId } });
    return { token: v.json.data.token, orgId: v.json.data.orgId };
  }
  return { token: d.token, orgId: d.orgId };
}
const idOf = (v) => (v && typeof v === 'object' ? (v._id || v.id) : v);
const strId = (v) => (idOf(v) ? String(idOf(v)) : '');

(async () => {
  const { token, orgId } = await login();
  console.log(`Authenticated. orgId=${orgId}`);

  // Finance department + its position ids.
  const dr = await api('/platform/board-members/departments-roles', { token, orgId });
  const depts = dr.json?.data ?? dr.json ?? [];
  const finance = depts.find((d) => String(d.name).toLowerCase() === 'finance');
  if (!finance) throw new Error('No Finance department.');
  const financePosIds = new Set((finance.roles || []).map((r) => String(r.id)));
  const financePosPref = (finance.roles || []).find((r) => (r.assignee_count || 0) === 0) || finance.roles[0];

  // All board members.
  const listRes = await api('/platform/board-members', { token, orgId });
  const members = (listRes.json?.data ?? listRes.json ?? []);
  const arr = Array.isArray(members) ? members : (members.items || members.boardMembers || []);
  console.log(`Board members: ${arr.length}`);

  const nameOf = (m) => `${m.given_names || ''} ${m.family_name || ''}`.trim().toLowerCase();
  const angela = arr.find((m) => (m.email || '').toLowerCase() === TARGET_EMAIL || nameOf(m) === TARGET_NAME);
  if (!angela) throw new Error(`Angela not found among board members (looked for ${TARGET_EMAIL}).`);
  const angelaId = strId(angela._id || angela.id);
  console.log(`Angela: id=${angelaId} pos=${strId(angela.position_id)} dept=${angela.department} hod=${angela.is_head_of_department}`);

  const inFinance = (m) => financePosIds.has(strId(m.position_id)) || String(m.department || '').toLowerCase() === 'finance';

  // Demote other Finance heads.
  const others = arr.filter((m) => strId(m._id || m.id) !== angelaId && m.is_head_of_department && inFinance(m));
  for (const m of others) {
    const r = await api(`/platform/board-members/${strId(m._id || m.id)}`, {
      method: 'PUT', token, orgId, body: { is_head_of_department: false },
    });
    console.log(`${r.json?.success ? 'demoted' : 'FAILED to demote'}: ${nameOf(m)}`);
  }

  // Ensure Angela is a Finance HOD (position in Finance + flag true).
  const body = { is_head_of_department: true, department: 'Finance' };
  if (!financePosIds.has(strId(angela.position_id))) {
    body.position = financePosPref.name;
    body.position_id = financePosPref.id;
  }
  const up = await api(`/platform/board-members/${angelaId}`, { method: 'PUT', token, orgId, body });
  if (!(up.status === 200 || up.json?.success)) {
    throw new Error(`Failed to set Angela as HOD: ${up.json?.error?.message || up.status} ` +
      `${JSON.stringify(up.json?.error?.details || '')}`);
  }
  console.log('\n+ Angela Martin is now Head of the Finance department (others demoted).');
  console.log(`  position: ${body.position || '(kept existing Finance position)'}  demoted others: ${others.length}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
