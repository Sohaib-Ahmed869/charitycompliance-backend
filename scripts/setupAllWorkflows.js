/**
 * setupAllWorkflows.js
 * ====================
 * Creates EVERY approval workflow ("approval matrix") for an organisation via
 * the platform API — the same endpoint the /role-permissions Workflow tab uses
 * (POST /platform/approvals/matrices). One workflow per category (25 total).
 *
 * Each workflow gets a single approval step routed to a board-level position
 * (so the two board-required categories — Risk Treatment and Related Party
 * Transactions — validate; the rest accept any position).
 *
 * Usage (PowerShell):
 *   $env:WF_EMAIL="zf12811@gmail.com"; $env:WF_PASSWORD="stewardex@123"; `
 *   node scripts/setupAllWorkflows.js
 *
 * Optional env:
 *   WF_API_BASE  API base URL (default: production Render backend)
 *   WF_OTP       OTP code if the account has MFA (default: 1743 dev bypass)
 *   WF_EFFECTIVE if "now" (default) the workflows are made active immediately.
 *
 * Requires Node 18+ (uses global fetch).
 */

const API_BASE = process.env.WF_API_BASE || 'https://charitycompliance-backend.onrender.com/api/v1';
const EMAIL = process.env.WF_EMAIL;
const PASSWORD = process.env.WF_PASSWORD;
const OTP = process.env.WF_OTP || '1743';

if (!EMAIL || !PASSWORD) {
  console.error('Set WF_EMAIL and WF_PASSWORD env vars.');
  process.exit(1);
}

// action_type -> default workflow_category (mirrors WorkflowTab ACTION_TO_CATEGORY_DEFAULT)
const ACTION_TO_CATEGORY = {
  risk: 'risk_management', risk_treatment: 'risk_treatment', complaint: 'complaint_resolution',
  coi: 'coi', partner_vetting: 'partner_vetting', supplier_vetting: 'supplier_vetting',
  policy: 'policy_approval', funding_agreement: 'funding_agreement', donation: 'donation_workflow',
  donation_agreement: 'donation_agreement_workflow', donation_milestone: 'donation_milestone_workflow',
  social_media_campaign: 'social_media_campaign_workflow', expense: 'expense_approval',
  project: 'project_approval', grant: 'grant_approval', donor: 'donor_review', emergency: 'emergency',
  sweep_funds: 'sweep_funds_approval', bas_lodgement: 'bas_lodgement_approval',
  financial_reporting: 'financial_reporting_approval', project_delivery: 'project_delivery_approval',
  project_delivery_changes: 'project_delivery_changes_approval', refunds: 'refunds_approval',
  members: 'members_approval', related_party_transaction: 'related_party_transaction',
};

// workflow_type required for these categories (mirrors WorkflowTab `needsType`).
const WORKFLOW_TYPE = {
  risk_management: 'high', funding_agreement: 'high_cash', expense_approval: 'high_cash',
  project_approval: 'high_cash', donor_review: 'large', grant_approval: 'large',
  sweep_funds_approval: 'high_cash',
};

// Board-level position must be the final approver for these.
const BOARD_REQUIRED = new Set(['risk_treatment', 'related_party_transaction']);

// The 25 categories (action_type + friendly name), grouped as in the UI.
const WORKFLOWS = [
  ['risk', 'Risk Management'], ['risk_treatment', 'Risk Treatment'], ['complaint', 'Complaints'],
  ['coi', 'Conflict of Interest'], ['partner_vetting', 'Partner Vetting'], ['policy', 'Policy Approvals'],
  ['related_party_transaction', 'Related Party Transactions'],
  ['funding_agreement', 'Funding Agreements'], ['grant', 'Grant Approvals'], ['project', 'Project Approvals'],
  ['project_delivery', 'Project Delivery'], ['project_delivery_changes', 'Project Delivery Changes'],
  ['donation', 'Donations'], ['donation_agreement', 'Donation Funding Agreements'],
  ['donation_milestone', 'Donation Milestones'], ['social_media_campaign', 'Social Media Campaigns'],
  ['donor', 'Donor Register'],
  ['expense', 'Expense Approvals'], ['supplier_vetting', 'Supplier Vetting'], ['refunds', 'Refunds'],
  ['sweep_funds', 'Sweep Funds'], ['bas_lodgement', 'BAS Lodgement'], ['financial_reporting', 'Fiscal Reports'],
  ['members', 'Member Approvals'], ['emergency', 'Emergency Response'],
];

async function api(path, { method = 'GET', body, token, orgId } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers['x-org-id'] = orgId;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function login() {
  const r = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.success) {
    throw new Error(`Login failed (${r.status}): ${JSON.stringify(r.json?.error || r.json)}`);
  }
  const d = r.json.data;
  if (d.needs_otp) {
    console.log('MFA required — verifying OTP...');
    const v = await api('/auth/otp/verify', {
      method: 'POST',
      body: { userId: d.user_id, code: OTP, orgId: d.orgId },
    });
    if (v.status !== 200 || !v.json?.success) {
      throw new Error(`OTP verify failed (${v.status}): ${JSON.stringify(v.json?.error || v.json)}`);
    }
    return { token: v.json.data.token, orgId: v.json.data.orgId };
  }
  return { token: d.token, orgId: d.orgId };
}

function flattenPositions(deptRoles) {
  const list = [];
  for (const dept of deptRoles || []) {
    for (const role of dept.roles || []) {
      list.push({
        positionId: role.id,
        name: role.name || role.title,
        department: dept.name,
        isBoard: !!role.is_board_level,
        assigned: (role.assignee_count || 0) > 0,
      });
    }
  }
  return list;
}

(async () => {
  console.log(`Logging in as ${EMAIL} ...`);
  const { token, orgId } = await login();
  console.log(`Authenticated. orgId=${orgId}`);

  const posRes = await api('/platform/board-members/departments-roles', { token, orgId });
  const positions = flattenPositions(posRes.json?.data ?? posRes.json);
  if (!positions.length) throw new Error('No positions found for this org — cannot set approvers.');

  const boardPos = positions.find((p) => p.isBoard && p.assigned)
    || positions.find((p) => p.isBoard)
    || null;
  const anyPos = positions.find((p) => p.assigned) || positions[0];
  console.log(`Positions: ${positions.length}. Board-level approver: ${boardPos ? boardPos.name : '(none)'}; ` +
    `default approver: ${anyPos.name}`);

  const effectiveFrom = (process.env.WF_EFFECTIVE ?? 'now') === 'now'
    ? new Date().toISOString() : undefined;

  let created = 0, skipped = 0, failed = 0;
  for (const [actionType, title] of WORKFLOWS) {
    const category = ACTION_TO_CATEGORY[actionType];
    const approver = BOARD_REQUIRED.has(category) ? boardPos : (boardPos || anyPos);
    if (!approver) { console.warn(`- SKIP ${title}: needs a board-level position, none available`); skipped++; continue; }

    const payload = {
      name: title,
      action_type: actionType,
      priority_level: 'high',
      priority: 3,
      workflow_category: category,
      positions: [{ positionId: approver.positionId, approvalLevel: 1 }],
    };
    if (WORKFLOW_TYPE[category]) payload.workflow_type = WORKFLOW_TYPE[category];
    if (effectiveFrom) payload.effective_from = effectiveFrom;

    const r = await api('/platform/approvals/matrices', { method: 'POST', body: payload, token, orgId });
    if (r.status === 201 || r.json?.success) {
      created++; console.log(`+ ${title} (${category})`);
    } else {
      const msg = r.json?.error?.message || r.json?.message || `HTTP ${r.status}`;
      if (/only one|already/i.test(msg)) { skipped++; console.log(`= ${title}: already exists`); }
      else { failed++; console.warn(`x ${title}: ${msg}`); }
    }
  }

  const all = await api('/platform/approvals/matrices', { token, orgId });
  const total = Array.isArray(all.json?.data) ? all.json.data.length : '?';
  console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}. ` +
    `Org now has ${total} workflows.`);
  process.exit(failed > 0 ? 2 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
