/**
 * Generate a Word doc snapshot of permissions and workflows for an organization.
 *
 * Usage:
 *   node scripts/generatePermissionsWorkflowsDoc.js <orgId> [outputPath]
 *
 * Example:
 *   node scripts/generatePermissionsWorkflowsDoc.js patricks_organization
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  ImageRun,
  PageBreak,
} from 'docx';

import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import { getTenantConnection, closeAllConnections } from '../src/db/connectionManager.js';
import { UserRepository } from '../src/repositories/userRepository.js';

import positionSchema from '../src/db/schemas/platform/positionSchema.js';
import departmentSchema from '../src/db/schemas/platform/departmentSchema.js';
import approvalMatrixSchema from '../src/db/schemas/platform/approvalMatrixSchema.js';
import organizationSchema from '../src/db/schemas/platform/organizationSchema.js';
import boardMemberSchema from '../src/db/schemas/platform/boardMemberSchema.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRAND_DEEP = '0A2E3F';
const BRAND_AZURE = '117A8B';
const TEXT_INK = '1F2937';
const TEXT_MUTED = '6B7280';
const BORDER = 'E5E7EB';
const SOFT_BLUE = 'EFF6FF';

const CATEGORY_DISPLAY = {
  risk_management: 'Risk Management',
  risk_treatment: 'Risk Treatment',
  complaint_resolution: 'Complaint Resolution',
  coi: 'Conflict of Interest',
  partner_vetting: 'Partner Vetting',
  funding_agreement: 'Funding Agreement',
  project_approval: 'Project Approval',
  expense_approval: 'Expense Approval',
  policy_approval: 'Policy Approval',
  donor_review: 'Donor Review',
  grant_approval: 'Grant Approval',
  donation_workflow: 'Donations',
  donation_agreement_workflow: 'Donation Funding Agreements',
  donation_milestone_workflow: 'Donation Milestones',
  social_media_campaign_workflow: 'Social Media Campaigns',
  hr_approval: 'HR Approval',
  sweep_funds_approval: 'Sweep Funds',
  emergency: 'Emergency Response',
  bas_lodgement_approval: 'BAS Lodgment',
  financial_reporting_approval: 'Fiscal Reports',
  project_delivery_approval: 'Project Delivery',
  project_delivery_changes_approval: 'Project Delivery Changes',
  refunds_approval: 'Refunds',
};

const MODULE_DISPLAY = {
  charity_admin: 'Charity Administration',
  policies: 'Policies & Procedures',
  reporting: 'Reporting',
  audit_trail: 'Audit Trail',
  complaints: 'Complaints',
  human_resources: 'People & HR',
  risk_mgmt: 'Risk Management',
  coi: 'Conflict of Interest',
  donation_boxes: 'Cash Handling',
  grants_donors: 'Grants & Donors',
  legal_docs: 'Legal Documents',
  bcp: 'Business Continuity',
  approval_workflow: 'Approval Workflows',
  financial_mgmt: 'Financial Controls',
  support_tickets: 'Support Tickets',
  dashboard: 'Dashboard',
  training: 'Training',
};

const orgId = (process.argv[2] || '').trim();
const outArg = process.argv[3];

if (!orgId) {
  console.error('Usage: node scripts/generatePermissionsWorkflowsDoc.js <orgId> [outputPath]');
  process.exit(1);
}

const titleCase = (s) => (s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const fmtPermission = (p) => {
  if (!p) return '';
  if (p === '*:*') return 'Full administrative access (*:*)';
  const m = p.match(/^module:([^:]+):(.+)$/);
  if (m) {
    const mod = MODULE_DISPLAY[m[1]] || titleCase(m[1]);
    const action = titleCase(m[2]);
    return `${mod} — ${action}`;
  }
  return titleCase(p.replace(':', ': '));
};

const cell = (text, opts = {}) => new TableCell({
  shading: opts.shaded ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill || SOFT_BLUE } : undefined,
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: BORDER },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
    left:   { style: BorderStyle.SINGLE, size: 4, color: BORDER },
    right:  { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  },
  margins: { top: 100, bottom: 100, left: 140, right: 140 },
  width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
  children: (Array.isArray(text) ? text : [text]).map((t) =>
    typeof t === 'string'
      ? new Paragraph({
          children: [
            new TextRun({
              text: t,
              bold: !!opts.bold,
              color: opts.color || (opts.shaded ? BRAND_DEEP : TEXT_INK),
              size: opts.size || 20,
            }),
          ],
        })
      : t
  ),
});

const heading1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 180 },
  children: [new TextRun({ text, bold: true, color: BRAND_DEEP, size: 36 })],
});

const heading2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text, bold: true, color: BRAND_DEEP, size: 28 })],
});

const heading3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 200, after: 80 },
  children: [new TextRun({ text, bold: true, color: BRAND_AZURE, size: 24 })],
});

const para = (text, opts = {}) => new Paragraph({
  spacing: { before: opts.before ?? 60, after: opts.after ?? 60 },
  alignment: opts.alignment,
  children: (Array.isArray(text) ? text : [text]).map((t) =>
    typeof t === 'string'
          ? new TextRun({
              text: t,
              bold: !!opts.bold,
              italics: !!opts.italic,
              color: opts.color || TEXT_INK,
              size: opts.size || 22,
            })
      : t
  ),
});

const bullet = (text, opts = {}) => new Paragraph({
  bullet: { level: opts.level || 0 },
  spacing: { before: 30, after: 30 },
  children: [new TextRun({ text, color: opts.color || TEXT_INK, size: opts.size || 22 })],
});

const divider = () => new Paragraph({
  spacing: { before: 100, after: 100 },
  border: { bottom: { color: BORDER, style: BorderStyle.SINGLE, size: 6 } },
  children: [new TextRun({ text: '' })],
});

async function main() {
  console.log(`\n📡 Connecting to Router DB…`);
  await connectRouterDB();

  console.log(`🔍 Looking up tenant: ${orgId}`);
  const tenantDb = await getTenantConnection(orgId);

  // Register models on tenant connection
  const Organization = tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);
  const Position = tenantDb.models.Position || tenantDb.model('Position', positionSchema);
  const Department = tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
  const ApprovalMatrix = tenantDb.models.ApprovalMatrix || tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
  const BoardMember = tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);

  // User repo (handles encryption decoding)
  const userRepo = new UserRepository(tenantDb);
  const User = userRepo.User;

  console.log(`📊 Reading data…`);
  const [org, users, positions, departments, matrices, boardMembers] = await Promise.all([
    Organization.findOne().lean(),
    User.find({ status: 'active' }).select('email first_name last_name is_org_owner status').lean(),
    Position.find({ is_active: true }).sort({ title: 1 }).lean(),
    Department.find().lean(),
    ApprovalMatrix.find({ is_active: true, revoked_at: null }).sort({ workflow_category: 1, workflow_type: 1 }).lean(),
    BoardMember.find({ is_active: true, status: 'active' }).select('user_id position_id position custom_position_title department is_board_member is_head_of_department is_volunteer').lean(),
  ]);

  console.log(`   • ${users.length} users`);
  console.log(`   • ${positions.length} positions`);
  console.log(`   • ${departments.length} departments`);
  console.log(`   • ${boardMembers.length} board-member records`);
  console.log(`   • ${matrices.length} active workflows`);

  // Index lookups
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  const positionsById = new Map(positions.map((p) => [String(p._id), p]));
  const deptsById = new Map(departments.map((d) => [String(d._id), d]));

  // user → board-member records (which carry the position link)
  const bmsByUser = new Map();
  for (const bm of boardMembers) {
    if (!bm.user_id) continue;
    const k = String(bm.user_id);
    if (!bmsByUser.has(k)) bmsByUser.set(k, []);
    bmsByUser.get(k).push(bm);
  }

  // For each user, derive their effective role + the positions they hold.
  const deriveUserRole = (u) => {
    if (u.is_org_owner) return { role: 'Admin', desc: 'Organization owner — full access (*:*)' };
    const bms = bmsByUser.get(String(u._id)) || [];
    const hasPos = bms.some((bm) => bm.position_id);
    if (hasPos) return { role: 'Board Member', desc: 'Inherits permissions from their assigned position(s)' };
    return { role: 'Board Member', desc: 'Basic access only — no position assigned' };
  };

  const positionsForUser = (u) => {
    const bms = bmsByUser.get(String(u._id)) || [];
    const out = [];
    for (const bm of bms) {
      let pos = bm.position_id ? positionsById.get(String(bm.position_id)) : null;
      // Fallback: match by title text if position_id is missing
      if (!pos && (bm.position || bm.custom_position_title)) {
        const label = (bm.custom_position_title || bm.position || '').toLowerCase().trim();
        pos = positions.find((p) => (p.title || '').toLowerCase().trim() === label) || null;
      }
      out.push({ pos, displayTitle: bm.custom_position_title || bm.position || pos?.title || '—', dept: bm.department || (pos?.department_id ? deptsById.get(String(pos.department_id))?.name : null) });
    }
    return out;
  };

  const userName = (u) => {
    if (!u) return '—';
    const n = `${u.first_name || ''} ${u.last_name || ''}`.trim();
    return n || u.email || '(unnamed)';
  };

  // ── DOC SECTIONS ────────────────────────────────────────────────────────
  const children = [];

  // Logo header
  const logoPath = path.resolve(__dirname, '../../charitycompliance-frontend/src/assets/logoFull.png');
  if (fs.existsSync(logoPath)) {
    const logoBuf = fs.readFileSync(logoPath);
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 240 },
      children: [
        new ImageRun({
          data: logoBuf,
          transformation: { width: 220, height: 70 },
          type: 'png',
        }),
      ],
    }));
  }

  // Title
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: 'Permissions & Workflows Snapshot', bold: true, color: BRAND_DEEP, size: 44 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text: org?.name || orgId, italics: true, color: TEXT_MUTED, size: 24 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 360 },
    children: [new TextRun({
      text: `Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
      color: TEXT_MUTED,
      size: 20,
    })],
  }));

  // Credentials box
  children.push(heading2('Sign-in Credentials'));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        cell('Email', { shaded: true, bold: true, width: 30 }),
        cell('patricksorg@yopmail.com', { width: 70 }),
      ]}),
      new TableRow({ children: [
        cell('Password', { shaded: true, bold: true, width: 30 }),
        cell('Stewardex@123', { width: 70 }),
      ]}),
      new TableRow({ children: [
        cell('Organization ID', { shaded: true, bold: true, width: 30 }),
        cell(orgId, { width: 70 }),
      ]}),
    ],
  }));
  children.push(para('Use these credentials to log in to the Stewardex platform. Sign in via the standard login page.', { italic: true, color: TEXT_MUTED, before: 100, after: 200 }));

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ── PERMISSIONS ─────────────────────────────────────────────────────────
  children.push(heading1('Permissions'));
  children.push(para(
    `This section lists every role and position defined in your organization, along with the specific permissions granted to each. Users inherit their effective permissions from the roles and positions they have been assigned.`,
    { color: TEXT_MUTED, before: 60, after: 200 }
  ));

  // ── Roles (derived, not stored)
  children.push(heading2('Roles'));
  children.push(para(
    'Roles in Stewardex are not stored as separate records — they are derived at sign-in from each user\'s account state. The model has two effective roles:',
    { color: TEXT_MUTED, before: 0, after: 100 }
  ));

  // Bucket users by derived role
  const adminUsers = users.filter((u) => u.is_org_owner);
  const boardWithPos = users.filter((u) => !u.is_org_owner && (bmsByUser.get(String(u._id)) || []).some((bm) => bm.position_id || bm.position));
  const boardNoPos = users.filter((u) => !u.is_org_owner && !(bmsByUser.get(String(u._id)) || []).some((bm) => bm.position_id || bm.position));

  // Admin
  children.push(heading3('Admin (Organization Owner)'));
  children.push(para('Full administrative access (*:*) — every module, every action. Automatically granted to the user who originally registered the organisation.', { before: 0, after: 100 }));
  if (adminUsers.length) {
    children.push(para(`Held by ${adminUsers.length} user${adminUsers.length === 1 ? '' : 's'}:`, { bold: true, before: 60, after: 40 }));
    for (const u of adminUsers) children.push(bullet(`${userName(u)} (${u.email || '—'})`));
  } else {
    children.push(para('No org-owner user found.', { italic: true, color: TEXT_MUTED, before: 0, after: 60 }));
  }
  children.push(divider());

  // Board Member with position
  children.push(heading3('Board Member — Position-based access'));
  children.push(para('Inherits the module permissions and granted action permissions defined on their assigned position(s). Multiple positions stack with most-permissive-wins. See Positions section below for the underlying permissions.', { before: 0, after: 100 }));
  if (boardWithPos.length) {
    const rows = [
      new TableRow({ children: [
        cell('User',     { shaded: true, bold: true, width: 30 }),
        cell('Email',    { shaded: true, bold: true, width: 30 }),
        cell('Position(s)', { shaded: true, bold: true, width: 40 }),
      ]}),
      ...boardWithPos
        .slice()
        .sort((a, b) => userName(a).localeCompare(userName(b)))
        .map((u) => {
          const titles = positionsForUser(u).map((x) => x.displayTitle).filter(Boolean);
          return new TableRow({ children: [
            cell(userName(u)),
            cell(u.email || '—'),
            cell(titles.length ? titles.join(', ') : '—'),
          ]});
        }),
    ];
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
  } else {
    children.push(para('No users currently hold a position.', { italic: true, color: TEXT_MUTED, before: 0, after: 60 }));
  }
  children.push(divider());

  // Board Member basic
  children.push(heading3('Board Member — Basic access'));
  children.push(para('Users with no position assigned. They retain only "read:own" and "write:own" — they can sign in but cannot operate any module beyond their own profile.', { before: 0, after: 100 }));
  if (boardNoPos.length) {
    children.push(para(`${boardNoPos.length} user${boardNoPos.length === 1 ? '' : 's'}:`, { bold: true, before: 60, after: 40 }));
    for (const u of boardNoPos) children.push(bullet(`${userName(u)} (${u.email || '—'})`));
  } else {
    children.push(para('No users without a position.', { italic: true, color: TEXT_MUTED, before: 0, after: 60 }));
  }
  children.push(divider());

  // ── Positions
  children.push(heading2(`Positions (${positions.length})`));
  children.push(para(
    'Positions are job-level grants. A user occupying a position inherits its module permissions and any explicit granted permissions on top of their role.',
    { color: TEXT_MUTED, before: 0, after: 120 }
  ));
  if (!positions.length) {
    children.push(para('No positions defined.', { color: TEXT_MUTED, italic: true }));
  } else {
    for (const pos of positions) {
      const dept = pos.department_id ? deptsById.get(String(pos.department_id)) : null;
      children.push(heading3(`${pos.title}${dept ? ` — ${dept.name}` : ''}`));

      const meta = [];
      if (pos.code) meta.push(`Code: ${pos.code}`);
      meta.push(`Level ${pos.level || 1}`);
      if (pos.is_management) meta.push('Management');
      if (Number(pos.max_approval_amount) > 0) meta.push(`Approval cap $${Number(pos.max_approval_amount).toLocaleString()}`);
      children.push(para(meta.join(' · '), { color: TEXT_MUTED, size: 18, before: 0, after: 80 }));
      if (pos.description) children.push(para(pos.description, { before: 0, after: 100 }));

      // Module permissions
      const modPerms = (pos.module_permissions || []).filter((mp) => mp.view || mp.edit || mp.delete);
      if (modPerms.length) {
        children.push(para('Module permissions:', { bold: true, before: 100, after: 40 }));
        const rows = [
          new TableRow({ children: [
            cell('Module',  { shaded: true, bold: true, width: 55 }),
            cell('View',    { shaded: true, bold: true, width: 15 }),
            cell('Edit',    { shaded: true, bold: true, width: 15 }),
            cell('Delete',  { shaded: true, bold: true, width: 15 }),
          ]}),
          ...modPerms
            .slice()
            .sort((a, b) => (a.module_id || '').localeCompare(b.module_id || ''))
            .map((mp) => new TableRow({ children: [
              cell(MODULE_DISPLAY[mp.module_id] || titleCase(mp.module_id)),
              cell(mp.view ? '✓' : '—', { color: mp.view ? '047857' : TEXT_MUTED }),
              cell(mp.edit ? '✓' : '—', { color: mp.edit ? '047857' : TEXT_MUTED }),
              cell(mp.delete ? '✓' : '—', { color: mp.delete ? '047857' : TEXT_MUTED }),
            ]})),
        ];
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      }

      // Granted permissions (action-scoped)
      if ((pos.granted_permissions || []).length) {
        children.push(para('Action permissions:', { bold: true, before: 120, after: 40 }));
        for (const p of pos.granted_permissions) children.push(bullet(fmtPermission(p)));
      }

      // Approval flags
      const approvalFlags = [];
      if (pos.can_approve_expenses) approvalFlags.push('Expenses');
      if (pos.can_approve_risks) approvalFlags.push('Risks');
      if (pos.can_approve_grants) approvalFlags.push('Grants');
      if (pos.can_approve_policies) approvalFlags.push('Policies');
      if (pos.can_approve_hr) approvalFlags.push('HR');
      if (approvalFlags.length) {
        children.push(para(`Can approve: ${approvalFlags.join(', ')}`, { color: BRAND_AZURE, before: 120, after: 60 }));
      }

      // Assigned users — link via BoardMember (system's actual user→position link)
      const assigned = boardMembers
        .filter((bm) => bm.position_id && String(bm.position_id) === String(pos._id) && bm.user_id)
        .map((bm) => usersById.get(String(bm.user_id)))
        .filter(Boolean);
      if (assigned.length) {
        children.push(para(`Held by ${assigned.length} user${assigned.length === 1 ? '' : 's'}:`, { bold: true, before: 120, after: 40 }));
        for (const u of assigned) children.push(bullet(`${userName(u)} (${u.email || '—'})`));
      }
      children.push(divider());
    }
  }

  // ── Users summary table
  children.push(heading2(`Users (${users.length})`));
  children.push(para(
    'Effective role is derived at sign-in from is_org_owner and any active board-member position assignment. Position(s) come from the user\'s linked board-member record(s).',
    { color: TEXT_MUTED, before: 0, after: 100 }
  ));
  if (users.length) {
    const rows = [
      new TableRow({ children: [
        cell('Name',     { shaded: true, bold: true, width: 26 }),
        cell('Email',    { shaded: true, bold: true, width: 30 }),
        cell('Role',     { shaded: true, bold: true, width: 18 }),
        cell('Position(s)', { shaded: true, bold: true, width: 26 }),
      ]}),
      ...users
        .slice()
        .sort((a, b) => userName(a).localeCompare(userName(b)))
        .map((u) => {
          const { role } = deriveUserRole(u);
          const titles = positionsForUser(u).map((x) => {
            const dept = x.dept ? ` (${x.dept})` : '';
            return `${x.displayTitle}${dept}`;
          });
          const display = u.is_org_owner ? `${userName(u)} — Owner` : userName(u);
          return new TableRow({ children: [
            cell(display),
            cell(u.email || '—'),
            cell(role),
            cell(titles.length ? titles.join(', ') : '—'),
          ]});
        }),
    ];
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
  } else {
    children.push(para('No users defined.', { color: TEXT_MUTED, italic: true }));
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ── WORKFLOWS ───────────────────────────────────────────────────────────
  children.push(heading1('Approval Workflows'));
  children.push(para(
    `Workflows define how approval requests are routed and who must sign off. Each workflow is scoped to a category (e.g. Expense Approval, Risk Management) and may further specialize by type (e.g. petty cash, low cash) or amount range.`,
    { color: TEXT_MUTED, before: 60, after: 200 }
  ));

  // Group matrices by category
  const matricesByCat = new Map();
  for (const m of matrices) {
    const k = m.workflow_category || 'other';
    if (!matricesByCat.has(k)) matricesByCat.set(k, []);
    matricesByCat.get(k).push(m);
  }
  const orderedCats = [...matricesByCat.keys()].sort((a, b) =>
    (CATEGORY_DISPLAY[a] || a).localeCompare(CATEGORY_DISPLAY[b] || b)
  );

  if (!orderedCats.length) {
    children.push(para('No active workflows configured.', { color: TEXT_MUTED, italic: true }));
  }

  for (const cat of orderedCats) {
    children.push(heading2(CATEGORY_DISPLAY[cat] || titleCase(cat)));
    const list = matricesByCat.get(cat) || [];

    for (const m of list) {
      const subtitle = [];
      if (m.workflow_type) subtitle.push(`Type: ${titleCase(m.workflow_type)}`);
      if (m.priority_level) subtitle.push(`Priority: ${titleCase(m.priority_level)}`);
      if (m.is_default) subtitle.push('Default');
      children.push(heading3(m.name));
      if (subtitle.length) children.push(para(subtitle.join(' · '), { color: TEXT_MUTED, size: 18, before: 0, after: 80 }));
      if (m.description) children.push(para(m.description, { before: 0, after: 100 }));

      const rules = m.rules || [];
      if (!rules.length) {
        children.push(para('No rules configured.', { italic: true, color: TEXT_MUTED, before: 60, after: 100 }));
      } else {
        for (let ri = 0; ri < rules.length; ri++) {
          const rule = rules[ri];
          const ruleHeader = [
            `Rule ${ri + 1}`,
            titleCase(rule.action_type || ''),
            `${titleCase(rule.approval_type || 'sequential')} approval`,
          ].filter(Boolean).join(' · ');
          children.push(para(ruleHeader, { bold: true, color: BRAND_AZURE, before: 100, after: 40 }));

          // Amount window
          const minA = Number(rule.min_amount) || 0;
          const maxA = Number(rule.max_amount);
          let amountLabel = '';
          if (Number.isFinite(maxA) && maxA > 0) amountLabel = `$${minA.toLocaleString()} – $${maxA.toLocaleString()}`;
          else if (minA > 0) amountLabel = `$${minA.toLocaleString()} and above`;
          else amountLabel = 'Any amount';
          children.push(para(`Amount: ${amountLabel}`, { color: TEXT_MUTED, size: 20, before: 0, after: 60 }));

          // Approver chain
          const approvers = (rule.requires_approval_from || []).slice().sort((a, b) => (a.approval_level || 0) - (b.approval_level || 0));
          if (approvers.length) {
            const rows = [
              new TableRow({ children: [
                cell('Level',     { shaded: true, bold: true, width: 12 }),
                cell('Approver',  { shaded: true, bold: true, width: 50 }),
                cell('Department',{ shaded: true, bold: true, width: 38 }),
              ]}),
              ...approvers.map((a) => {
                let name = '—';
                if (a.user_id) name = userName(usersById.get(String(a.user_id)));
                else if (a.position_id) name = positionsById.get(String(a.position_id))?.title || '(position)';
                else name = '(unspecified)';
                let dept = '—';
                if (a.department_id) dept = deptsById.get(String(a.department_id))?.name || '—';
                else if (a.position_id) {
                  const p = positionsById.get(String(a.position_id));
                  if (p?.department_id) dept = deptsById.get(String(p.department_id))?.name || '—';
                }
                const kind = a.user_id ? 'User' : a.position_id ? 'Position' : a.department_id ? 'Department head' : '—';
                return new TableRow({ children: [
                  cell(String(a.approval_level || '—')),
                  cell([new Paragraph({ children: [new TextRun({ text: name, bold: true, color: TEXT_INK, size: 20 })] }),
                        new Paragraph({ children: [new TextRun({ text: kind, italics: true, color: TEXT_MUTED, size: 18 })] })]),
                  cell(dept),
                ]});
              }),
            ];
            children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
          } else {
            children.push(para('No approvers assigned.', { italic: true, color: TEXT_MUTED, before: 0, after: 100 }));
          }
        }
      }

      // Default approver
      if (m.default_approver?.position_id || m.default_approver?.user_id) {
        let dn = '';
        if (m.default_approver.user_id) dn = userName(usersById.get(String(m.default_approver.user_id)));
        else if (m.default_approver.position_id) dn = positionsById.get(String(m.default_approver.position_id))?.title || '';
        if (dn) children.push(para(`Fallback approver: ${dn}`, { color: TEXT_MUTED, italic: true, before: 80, after: 100 }));
      }

      // Effective dates
      const dateBits = [];
      if (m.effective_from) dateBits.push(`From ${new Date(m.effective_from).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`);
      if (m.effective_to) dateBits.push(`Until ${new Date(m.effective_to).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`);
      if (dateBits.length) children.push(para(`Effective: ${dateBits.join(' · ')}`, { color: TEXT_MUTED, size: 18, before: 60, after: 80 }));

      children.push(divider());
    }
  }

  // ── FOOTER
  children.push(para(' ', { before: 200, after: 0 }));
  children.push(para(
    'This document was generated automatically from the live system snapshot. For changes, contact your Stewardex administrator.',
    { color: TEXT_MUTED, italic: true, alignment: AlignmentType.CENTER, before: 200, after: 0, size: 18 }
  ));

  // ── BUILD DOC
  const doc = new Document({
    creator: 'Stewardex',
    title: 'Permissions & Workflows Snapshot',
    description: `Permissions and workflows for ${org?.name || orgId}`,
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);

  const defaultOut = path.resolve(__dirname, `../../${(org?.name || orgId).replace(/[^a-z0-9_-]+/gi, '_')}_permissions_workflows.docx`);
  const outPath = outArg ? path.resolve(outArg) : defaultOut;
  fs.writeFileSync(outPath, buffer);
  console.log(`\n✅ Saved: ${outPath}`);

  await closeAllConnections();
  await closeRouterDB();
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
