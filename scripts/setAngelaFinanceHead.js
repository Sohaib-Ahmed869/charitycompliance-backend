/**
 * setAngelaFinanceHead.js
 * =======================
 * Makes Angela Martin show as the Finance department HEAD.
 *
 * The Org Chart derives a department's head from the most senior position that
 * is either `is_management` or "board-level" (held by a board member). Finance
 * has no management position, so the lever is board-membership: flag Angela
 * (on Finance Manager) as a board member -> her position becomes the head slot.
 * Also keeps is_head_of_department=true (used for approval routing).
 *
 * Usage: $env:WF_EMAIL="zf12811@gmail.com"; $env:WF_PASSWORD="Password123!"; node scripts/setAngelaFinanceHead.js
 */

const API_BASE = process.env.WF_API_BASE || 'https://charitycompliance-backend.onrender.com/api/v1';
const EMAIL = process.env.WF_EMAIL, PASSWORD = process.env.WF_PASSWORD, OTP = process.env.WF_OTP || '1743';
const TARGET_EMAIL = 'angela.martin@yopmail.com', TARGET_NAME = 'angela martin';
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
const strId = (v) => (v && typeof v === 'object' ? String(v._id || v.id) : (v ? String(v) : ''));

(async () => {
  const { token, orgId } = await login();
  console.log(`Authenticated. orgId=${orgId}`);
  const listRes = await api('/platform/board-members', { token, orgId });
  const raw = listRes.json?.data ?? listRes.json ?? [];
  const arr = Array.isArray(raw) ? raw : (raw.items || raw.boardMembers || []);
  const nameOf = (m) => `${m.given_names || ''} ${m.family_name || ''}`.trim().toLowerCase();
  const angela = arr.find((m) => (m.email || '').toLowerCase() === TARGET_EMAIL || nameOf(m) === TARGET_NAME);
  if (!angela) throw new Error('Angela not found.');
  const id = strId(angela._id || angela.id);
  console.log(`Angela id=${id} pos=${strId(angela.position_id)} dept=${angela.department} ` +
    `board_member=${angela.is_board_member} hod=${angela.is_head_of_department}`);

  const up = await api(`/platform/board-members/${id}`, {
    method: 'PUT', token, orgId,
    body: { is_board_member: true, is_head_of_department: true },
  });
  if (!(up.status === 200 || up.json?.success)) {
    throw new Error(`Update failed: ${up.json?.error?.message || up.status} ` +
      JSON.stringify(up.json?.error?.details || ''));
  }
  console.log('\n+ Angela Martin is now a board member holding the Finance Manager position');
  console.log('  -> she is the Finance department head in the org chart (and HOD for approvals).');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
