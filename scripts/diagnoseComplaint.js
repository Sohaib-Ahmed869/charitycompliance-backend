/**
 * diagnoseComplaint.js — inspect a complaint's approval state to explain why
 * the assigned approver can't act. Read-only.
 * Usage: $env:WF_EMAIL=..; $env:WF_PASSWORD=..; $env:CMP_REF="CMP-2026-092"; node scripts/diagnoseComplaint.js
 */
const API = process.env.WF_API_BASE || 'https://charitycompliance-backend.onrender.com/api/v1';
const EMAIL = process.env.WF_EMAIL, PASSWORD = process.env.WF_PASSWORD, OTP = process.env.WF_OTP || '1743';
const REF = process.env.CMP_REF || 'CMP-2026-092';

async function api(path, { method = 'GET', body, token, orgId } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (orgId) h['x-org-id'] = orgId;
  const r = await fetch(`${API}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function login() {
  const r = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const d = r.j.data;
  if (d.needs_otp) { const v = await api('/auth/otp/verify', { method: 'POST', body: { userId: d.user_id, code: OTP, orgId: d.orgId } }); return { token: v.j.data.token, orgId: v.j.data.orgId }; }
  return { token: d.token, orgId: d.orgId };
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));
const sid = (v) => (v && typeof v === 'object' ? (v._id || v.id) : v);

(async () => {
  const { token, orgId } = await login();
  console.log('orgId=', orgId);

  // Find the complaint by reference.
  let list = (await api('/platform/complaints/list', { token, orgId })).j;
  let arr = list?.data ?? list ?? [];
  if (!Array.isArray(arr)) arr = arr.items || arr.complaints || [];
  if (!arr.length) { const l2 = (await api('/platform/complaints', { token, orgId })).j; arr = l2?.data ?? l2 ?? []; }
  console.log(`Found ${arr.length} complaints. Fetching details...`);
  const details = [];
  for (const item of arr) {
    const cid = sid(item._id || item.id);
    const dRes = await api(`/platform/complaints/${cid}`, { token, orgId });
    const d = dRes.j?.data ?? dRes.j;
    if (d) details.push(d);
    console.log(`  - ${sid(d._id)} ref=${d?.reference || d?.reference_number || d?.complaint_reference || '?'} ` +
      `stage=${d?.workflow_stage} major=${d?.is_major} status=${d?.status}`);
  }
  // Prefer the one matching REF, else the major / resolution one.
  const c = details.find((d) => JSON.stringify(d).includes(REF))
    || details.find((d) => d.is_major || d.workflow_stage === 'workflow_resolution' || d.workflow_stage === 'board_signoff')
    || details[0];
  const id = sid(c._id || c.id);
  console.log('\n=== COMPLAINT', REF, '===');
  console.log(pick(c, ['reference', 'workflow_stage', 'is_major', 'status', 'is_invalid']));
  console.log('board_signoff_user_id      =', sid(c.board_signoff_user_id));
  console.log('board_signoff_board_member =', sid(c.board_signoff_board_member_id));
  console.log('workflow_instance_id       =', sid(c.workflow_instance_id));
  console.log('category.head_user_id      =', sid(c.category?.head_user_id));
  console.log('resolution_details present =', !!c.resolution_details, c.resolution_details ? pick(c.resolution_details, ['root_cause']) : '');

  // Attached approval workflow status + current pending approver.
  if (c.workflow_instance_id) {
    const wRes = await api(`/platform/approvals/${sid(c.workflow_instance_id)}`, { token, orgId });
    const w = wRes.j?.data ?? wRes.j;
    console.log('\n=== ATTACHED WORKFLOW ===');
    console.log('status =', w?.status);
    (w?.approval_steps || []).forEach((s, i) => {
      console.log(`  step ${i}: status=${s.status} approver_user_id=${sid(s.approver_user_id)} ` +
        `position=${sid(s.position_id) || s.position_name || ''} approver=${s.approver_name || ''}`);
    });
  }

  // Kelly's board member -> user linkage.
  const bmRes = await api('/platform/board-members', { token, orgId });
  const bms = bmRes.j?.data ?? bmRes.j ?? [];
  const kelly = (Array.isArray(bms) ? bms : []).find((m) => `${m.given_names} ${m.family_name}`.toLowerCase().includes('kelly'));
  if (kelly) {
    console.log('\n=== KELLY (board member) ===');
    console.log('bm_id=', sid(kelly._id), 'user_id=', sid(kelly.user_id), 'position_id=', sid(kelly.position_id),
      'is_board_member=', kelly.is_board_member, 'dept=', kelly.department);
    console.log('board_signoff_board_member matches Kelly?', String(sid(c.board_signoff_board_member_id)) === String(sid(kelly._id)));
    console.log('board_signoff_user_id set?', !!sid(c.board_signoff_user_id),
      ' equals Kelly.user_id?', String(sid(c.board_signoff_user_id) || '') === String(sid(kelly.user_id) || ''));
  } else {
    console.log('\nKelly not found among board members:', (bms || []).map((m) => `${m.given_names} ${m.family_name}`).join(', '));
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
