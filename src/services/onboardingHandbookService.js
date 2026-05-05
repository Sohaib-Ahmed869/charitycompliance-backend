/**
 * Onboarding Handbook PDF generator.
 *
 * Renders a comprehensive, brand-styled onboarding handbook tailored to the
 * customer's organisation. Includes: pre-flight info checklist, setup
 * walkthrough, module-by-module guide, glossary, troubleshooting, and FAQ.
 *
 * Uses the same Puppeteer pipeline as our other PDFs so the artefact
 * automatically picks up org logo, brand colours, and the headed/footed
 * page layout. Stewardex wordmark is an inline SVG so it always renders
 * regardless of asset availability.
 */

import puppeteer from 'puppeteer';
import { resolveLogoSrcForPdf } from '../utils/pdfLogo.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const formatDate = (d = new Date()) =>
  d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

// Stewardex wordmark — always-available brand mark for the cover and footer.
// Pure SVG so it scales perfectly at print resolution and never depends on
// an external asset that might not be deployed alongside the backend.
const STEWARDEX_WORDMARK_SVG = `
<svg viewBox="0 0 220 40" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sx-mark-gradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0A2E3F"/>
      <stop offset="100%" stop-color="#117A8B"/>
    </linearGradient>
  </defs>
  <g transform="translate(0,0)">
    <rect x="0" y="6" width="28" height="28" rx="7" fill="url(#sx-mark-gradient)"/>
    <path d="M9 16 L19 16 L19 18 L11 18 L11 21 L19 21 L19 24 L11 24 L11 27 L19 27 L19 29 L9 29 Z" fill="#fff"/>
  </g>
  <text x="40" y="28" font-family="'Inter', sans-serif" font-size="20" font-weight="700" fill="url(#sx-mark-gradient)" letter-spacing="0.5">Stewardex</text>
</svg>`;

/**
 * Module reference data used by the body. Each entry becomes a section in
 * the "Module-by-module guide". Kept in one place so the TOC and chapter
 * dividers stay in sync with the actual content.
 */
const MODULES = [
  {
    id: 'dashboard', title: 'Dashboard',
    purpose: 'A live snapshot of your charity — outstanding approvals, overdue reviews, recent activity, and onboarding progress.',
    use: [
      'Open the Dashboard from the sidebar (always visible to every user).',
      'Each tile is a deep-link to the module behind it; click an outstanding approval to open it directly.',
      'The "Setup progress" card vanishes once your initial onboarding is complete.'
    ],
    tips: 'Most users will live on the Dashboard. Pin browser tabs at /dashboard for the team.'
  },
  {
    id: 'calendar', title: 'Calendar',
    purpose: 'A unified view of meetings, registration & licence renewals, training due dates, and policy review windows.',
    use: [
      'Switch between month, week, and agenda layouts.',
      'Click any item to open the source record — meetings, training, etc.',
      'External calendar invites (.ics) are emailed automatically when meetings are scheduled.'
    ],
    tips: 'Renewal dates ride on the same calendar so you can see compliance deadlines next to ordinary meetings.'
  },
  {
    id: 'meetings', title: 'Meetings',
    purpose: 'Schedule meetings, capture attendance, store agendas and minutes, and trigger follow-up tasks.',
    use: [
      'Create a meeting → invite attendees by name (auto-fills from your team list).',
      'Upload the agenda and minutes — both are stored in the audit trail.',
      'Action items become tasks for the assigned person.'
    ],
    tips: 'Mandatory board-meeting frequency in Australia: most charities hold quarterly. Stewardex flags overdue meetings on the Dashboard.'
  },
  {
    id: 'tasks', title: 'My Tasks',
    purpose: 'Personal task list rolled up from every module — approvals waiting on you, training due, action items, suitability follow-ups.',
    use: [
      'The list groups tasks by source so you can see why each one was created.',
      '"Mark complete" updates the upstream record (e.g. closes a training assignment).',
      'Overdue tasks turn red and appear at the top.'
    ],
    tips: 'If a task feels stuck, click through to the source — there\'s usually a workflow guard or permission issue you can resolve.'
  },
  {
    id: 'chat', title: 'Chat',
    purpose: 'In-platform messaging — department channels, organisation-wide announcements, direct messages, and read receipts.',
    use: [
      'Channels: department channels are auto-provisioned from your governance structure; #general and #announcements are org-wide.',
      'Direct messages: start a 1:1 conversation with anyone in your organisation.',
      'Mentions: type @ to mention a person, or # to reference a system entity (a policy, a risk, etc.) and link to it inline.',
      'Voice notes: hold the microphone icon to record up to 5 minutes of audio.',
      'Compliance alerts: pasting numbers that look like ABNs, credit cards, or AU phone numbers triggers a sensitivity warning.'
    ],
    tips: 'Use #announcements for one-way org-wide updates (only admins can post). Department channels are scoped to that department\'s members.'
  },
  {
    id: 'approvals', title: 'Approval Workflow',
    purpose: 'Multi-step approvals for expenses, risks, policies, sweep-funds, registrations, BAS lodgements, AIS reports, COI declarations, and more.',
    use: [
      'A workflow is a chain of approval steps; each step is satisfied by a specific role or named user.',
      'Submit a request → it routes to the first approver → if approved, moves to the next step → on full approval, the underlying record (expense, etc.) becomes active.',
      'A reviewer can: approve, reject, escalate (request a second opinion), or forward a rejection for review.',
      'Workflows are categorised — Risk Treatment, Expense, Policy, Sweep Funds, BAS, AIS, etc. Each category has its own matrix.',
      'If a record\'s category has no configured workflow, you\'ll see a "Workflow not configured" guard with a button to set one up.'
    ],
    tips: 'Configure your workflows BEFORE you start submitting things. Otherwise users hit the workflow-guard dialog and the request is held.'
  },
  {
    id: 'audit-trail', title: 'Audit Trail',
    purpose: 'Tamper-evident record of every governance event — approvals, edits, file uploads, role changes, and signatures.',
    use: [
      'Every change writes a row with: who, when, what, and a hash of the previous record.',
      'Filter by user, date range, or entity type.',
      'Export to PDF for auditors or board packs.'
    ],
    tips: 'The chain is hash-linked, so any tampered row breaks the verification. Auditors love this.'
  },
  {
    id: 'coi', title: 'Conflict of Interest',
    purpose: 'Capture, declare, and review COIs for trustees, board members, and project staff.',
    use: [
      'Each responsible person declares known COIs at onboarding and on a recurring schedule.',
      'When a workflow approver has a recorded COI on the entity being approved, the request is auto-paused for COI review.',
      'COIs can be declared internally or via a public link sent to external partners.'
    ],
    tips: 'Treat COIs as required by law — ACNC Governance Standard 5 expects responsible persons to disclose and manage conflicts.'
  },
  {
    id: 'charity-administration', title: 'Charity Administration',
    purpose: 'Your charity\'s "system of record" — organisation profile, governance documents, responsible people, registrations, and yearly statements.',
    use: [
      'Organisation Chart: visual hierarchy of departments, heads, and positions.',
      'Overview: legal name, ABN, ACNC reg #, address, financial-year end.',
      'Registrations & Licenses: track expiry dates with auto-reminders.',
      'Responsible People: Director ID, suitability docs, contracts, induction status.',
      'Governing Doc: constitution / rule book / code of conduct.',
      'Approval Thresholds: dollar thresholds that determine which approval matrix kicks in.',
      'Yearly Statements: AIS + ACNC Annual Financial Report archive.'
    ],
    tips: 'The Organisation Chart auto-renders from your governance structure. Set departments and reporting lines first, the chart follows.'
  },
  {
    id: 'policies', title: 'Policies & Procedures',
    purpose: 'Policy lifecycle — draft, review, approve, publish, and re-review on a schedule.',
    use: [
      'Upload an existing policy or create one from a template.',
      'Each policy has a category (e.g. Privacy, WHS, Financial) and a review cadence.',
      'When the next-review date approaches, owners get reminders 30/14/7 days out.',
      'Volunteers and staff can be required to acknowledge specific policies as part of induction.'
    ],
    tips: 'Mark policies that need board-level approval — they\'ll route through your Policy approval workflow rather than just publishing immediately.'
  },
  {
    id: 'people-hr', title: 'People & HR',
    purpose: 'Employee register, training programs, training register, disciplinary records, and "My Training" personal view.',
    use: [
      'Employees: profile, position, start/end dates, contract, contact info.',
      'Training: assign courses to specific positions or individuals; track completion.',
      'Training Register: top-down view of who\'s completed what.',
      'Disciplinary Records: confidential incidents, outcomes, and follow-ups (HR-managers only).',
      'My Training: every staff member\'s personal page showing assigned courses.'
    ],
    tips: 'HR-management views are hidden from non-HR staff. They see only "My Training", which is everyone\'s personal page.'
  },
  {
    id: 'volunteers', title: 'Volunteers',
    purpose: 'Volunteer onboarding, policy acknowledgements, action assignments, and offboarding.',
    use: [
      'Register volunteers with name, contact, and assigned program.',
      'Send a public link for the volunteer to acknowledge mandatory policies.',
      'Track hours and assign actions like "complete WHS induction".'
    ],
    tips: 'Volunteers don\'t consume a paid seat — they have a separate listing track distinct from staff.'
  },
  {
    id: 'access-offboarding', title: 'Access Control & Offboarding',
    purpose: 'Manage IT access reviews and the offboarding workflow when someone leaves.',
    use: [
      'When a position is filled by a new person, the old user is auto-flagged for offboarding.',
      'Offboarding checklist: revoke logins, return assets, finalise pay, complete exit interview.',
      'Optional integration with the IT System Register so each user\'s system access is shown alongside.'
    ],
    tips: 'Mark "no successor" if the role is being closed, not transferred — the workflow runs differently.'
  },
  {
    id: 'risk', title: 'Risk Management',
    purpose: 'Risk register with consequence × likelihood scoring, treatment plans, residual ratings, and a heat map.',
    use: [
      'Add a risk → choose a category and department → set inherent consequence (1-5) and likelihood (1-5).',
      'Score = C × L, banded into Low (1-4), Minor (5-8), Moderate (9-12), High (13-16), Severe (17-20), Critical (21-25).',
      'Add treatments (controls) to reduce the residual rating; treatments go through their own approval workflow.',
      'Heat map shows the count of risks at every cell; export the register + heat map as PDF.'
    ],
    tips: 'Use the period filter on the heat map to compare risk profiles across financial years.'
  },
  {
    id: 'finance', title: 'Financial Controls',
    purpose: 'Expense approvals, signatory management, and dollar-threshold-driven approval routing.',
    use: [
      'Expenses: submit with category, amount, vendor, date, and supporting documents.',
      'Signatories: who can authorise payments at each tier.',
      'Thresholds: over $X requires an additional approver; over $Y requires board approval.',
      'Receipts and invoices are stored in the audit trail.'
    ],
    tips: 'Review and tune your thresholds on the "Approval Thresholds" page under Charity Administration.'
  },
  {
    id: 'sweep-funds', title: 'Sweep Funds',
    purpose: 'Multi-signature movement of funds between bank accounts (e.g. operating to investment).',
    use: [
      'Create a sweep request with from-account, to-account, amount, and rationale.',
      'Each sweep follows your Sweep Funds approval workflow — typically 2+ signatories.',
      'Once approved, the audit trail records the movement; actual bank transfer happens externally.'
    ],
    tips: 'This module records governance decisions, not actual bank API integration. You still execute the transfer in your bank.'
  },
  {
    id: 'cash-handling', title: 'Cash Handling (Donation Boxes)',
    purpose: 'Track physical donation boxes — placement, count events, and bank deposits.',
    use: [
      'Register a box with location, custodian, and seal number.',
      'Each count is a workflow: two staff members count, sign off, and lodge the cash.',
      'Bank deposit slip closes the loop; the workflow records the deposit confirmation.'
    ],
    tips: 'Use the workflow approvals here — counting cash without dual sign-off is a major audit finding.'
  },
  {
    id: 'grants-donors', title: 'Grants & Donors',
    purpose: 'Donor register, grant pipeline, partner vetting, funding agreements, project monitoring.',
    use: [
      'Donor Register: contact, donation history, communication preferences.',
      'Marketing: campaigns and outreach (separate module).',
      'Project Delivery: vet partners → sign funding agreements → register projects → monitor and refund where needed.'
    ],
    tips: 'Donor data is encrypted at rest. Search uses a blind index so we can find donors without decrypting every record.'
  },
  {
    id: 'reporting', title: 'Reporting & Compliance',
    purpose: 'Generate AIS, ACNC Annual Financial Report, weekly board reports, fiscal reports, and BAS submissions.',
    use: [
      'AIS Wizard: pre-fills from your data, generates a branded PDF, and (Phase 1) an editable Word doc you can layer accounting figures into.',
      'BAS Lodgement: monthly / quarterly / yearly toggle; each cell is one BAS submission.',
      'Fiscal Reports: monthly and yearly archives with workflow approvals before filing.'
    ],
    tips: 'BAS frequency is set by the ATO based on your GST turnover — pick the right tab.'
  },
  {
    id: 'legal-it', title: 'Legal Documents & IT System Register',
    purpose: 'Catalogue every contract, agreement, insurance certificate, and IT system you depend on.',
    use: [
      'Legal: store insurance certs, contracts, leases — with renewal alerts.',
      'IT Register: every system (CRM, accounting, donation portal) with the data classes it holds, the owner, and the last access review date.'
    ],
    tips: 'A maintained IT register is a major win for cyber-insurance claims and for ACNC privacy obligations.'
  },
  {
    id: 'complaints', title: 'Complaints',
    purpose: 'Intake, triage, and resolution of complaints from staff, beneficiaries, and the public.',
    use: [
      'Complaints can be lodged internally or through a public form (no login required).',
      'Each complaint becomes a tracked record with comments, evidence, and a resolution outcome.',
      'Sensitive complaints (e.g. HR matters) are restricted to the relevant role.'
    ],
    tips: 'Public complaints generate a tracking ID — share it with the complainant so they can follow up later.'
  },
  {
    id: 'bcp', title: 'Business Continuity Plan (BCP)',
    purpose: 'Document and rehearse your continuity plan — succession, alternate contacts, critical-vendor list.',
    use: [
      'Maintain a list of every position with its successor and BCP-eligibility status.',
      'When the BCP is triggered, succession kicks in and "Position transferred" is enforced platform-wide on the original holder.',
      'Annual rehearsal log captures when the plan was last tested.'
    ],
    tips: 'Don\'t skip rehearsals. ACNC governance standards expect that critical roles have nominated succession.'
  },
  {
    id: 'permissions', title: 'Permissions and Workflows',
    purpose: 'The setup page for positions, module permissions, and approval matrices.',
    use: [
      'Define positions (e.g. CEO, Treasurer, Head of HR), each with module-level view/edit/delete permissions.',
      'Configure approval matrices per workflow category (Expense, Policy, Risk, etc.).',
      'Test a matrix: pick a hypothetical request and see who it would route to.'
    ],
    tips: 'Permissions recompute on every request for non-admin users — change a position\'s permissions and the change applies immediately.'
  },
  {
    id: 'checklists', title: 'Checklists',
    purpose: 'Create reusable checklist templates that get attached to specific workflows or modules.',
    use: [
      'Build a template: Title, items, optional evidence requirements per item.',
      'Bind templates to modules (e.g. "BAS Lodgement Checklist").',
      'When a workflow runs, the checklist appears alongside the request — items are marked off as evidence is uploaded.'
    ],
    tips: 'Use checklists to capture the "10 things every BAS must include" so submissions don\'t miss steps.'
  }
];

const PRE_FLIGHT = [
  { group: 'Identity', items: [
    ['Legal name', 'As registered with the ACNC.'],
    ['Trading name', 'If different from legal name.'],
    ['ABN', '11-digit Australian Business Number.'],
    ['ACN', '9-digit Australian Company Number (if incorporated as a company).'],
    ['ACNC registration number', 'From your ACNC profile.'],
    ['Registration state', 'NSW / VIC / QLD / SA / WA / TAS / NT / ACT.'],
    ['Established date', 'When the charity was established.'],
    ['Logo', 'PNG or JPG, ideally 512×512 or larger, transparent background preferred.']
  ] },
  { group: 'Tax & compliance', items: [
    ['Financial year end', 'Australian charities default to 30 June; can be customised.'],
    ['DGR status', 'Deductible Gift Recipient — yes/no, item number if applicable.'],
    ['GST registration', 'Are you registered for GST? Required if turnover > $150k for not-for-profits.'],
    ['BAS frequency', 'Monthly / Quarterly / Yearly — set by the ATO based on your GST turnover.'],
    ['ATO contact email', 'For correspondence routing.']
  ] },
  { group: 'Governance', items: [
    ['Departments', 'List of every department: Board of Directors, Operations, Finance, etc.'],
    ['Positions', 'Each role title, the department it belongs to, and reporting line (who it reports to).'],
    ['Responsible people', 'Trustee/director name, position, email, Director ID, start date.'],
    ['Governing documents', 'Constitution, rule book, code of conduct — as PDFs.'],
    ['Approval thresholds', 'Dollar tiers that determine when extra approvers are required.'],
    ['Working with vulnerable communities', 'Yes/no flag for ATSI / children / elderly safeguarding.']
  ] },
  { group: 'Operations', items: [
    ['Insurance certificates', 'Public liability, professional indemnity, D&O — with expiry dates.'],
    ['IT systems', 'Every cloud service / app you use that holds charity data.'],
    ['Bank accounts', 'For Sweep Funds and Financial Controls — account names, BSBs, and the signatories per account.'],
    ['Donation channels', 'Donation boxes, online giving links, recurring donor lists.'],
    ['Programs', 'Active programs, beneficiaries, program managers, locations.']
  ] },
  { group: 'People', items: [
    ['Staff list', 'Name, position, start date, contract, manager.'],
    ['Volunteer list', 'Optional but recommended — name, contact, programs they support.'],
    ['Auditor invites', 'Read-only access for external auditors during audit windows.']
  ] }
];

const GLOSSARY = [
  ['ABN', 'Australian Business Number — 11-digit identifier issued by the ATO.'],
  ['ACN', 'Australian Company Number — 9-digit identifier for incorporated companies.'],
  ['ACNC', 'Australian Charities and Not-for-profits Commission — the national regulator.'],
  ['AIS', 'Annual Information Statement — the yearly report each registered charity files with the ACNC.'],
  ['Approval matrix', 'The chain of who must approve a given request before it takes effect.'],
  ['Audit trail', 'Tamper-evident log of every governance event in Stewardex.'],
  ['BAS', 'Business Activity Statement — periodic GST and PAYG report lodged with the ATO.'],
  ['BCP', 'Business Continuity Plan — succession and continuity-of-operations planning.'],
  ['Blind index', 'A keyed hash of an encrypted field that allows equality search without decrypting (used for emails, ABN, etc.).'],
  ['Board level', 'A position held by an active board member; surfaces a BOARD chip in the org chart.'],
  ['COI', 'Conflict of Interest — a declared relationship that may bias a decision.'],
  ['DGR', 'Deductible Gift Recipient — donations are tax-deductible if your charity is endorsed.'],
  ['Department', 'A grouping of positions in your governance structure (e.g. Finance, Operations).'],
  ['Director ID', 'Australia\'s mandatory unique director identifier (15-digit) for company directors.'],
  ['FY', 'Financial Year — the 12-month accounting period; in Australia 1 July to 30 June by default.'],
  ['Inherent risk', 'The risk score before any controls are applied.'],
  ['KPI', 'Key Performance Indicator — typically a number tile on the Dashboard.'],
  ['Module', 'A feature area in Stewardex (Risk, Approvals, Chat, etc.) — each module has its own permissions.'],
  ['MFA', 'Multi-Factor Authentication — required for admins and recommended for everyone.'],
  ['Organisation owner', 'The user with `is_org_owner: true` — the top-of-tree admin for your tenant.'],
  ['PAYG', 'Pay As You Go — withholding tax for employees; reported in BAS.'],
  ['Position', 'A role definition (e.g. Treasurer); a person fills a position via a BoardMember record.'],
  ['Responsible person (RP)', 'A trustee/director/committee member as defined by the ACNC.'],
  ['Residual risk', 'The risk score after controls (treatments) are applied.'],
  ['Suitability', 'The vetting record — police checks, working with children checks, qualifications — for a responsible person.'],
  ['Tenant DB', 'Your organisation\'s isolated database; every customer has their own.'],
  ['Workflow guard', 'The dialog that opens when you try to submit something whose category has no configured approval workflow.']
];

const TROUBLESHOOTING = [
  {
    problem: '"Workflow not configured" dialog appears when I try to submit',
    cause: 'The category of the thing you\'re submitting (Expense, Risk Treatment, Policy, etc.) has no approval matrix yet.',
    fix: 'Click "Open workflow setup" in the dialog → it deep-links to Permissions and Workflows with the right category pre-selected. Configure at least one matrix and save. Try the submission again.'
  },
  {
    problem: '"Position transferred" error when logging in',
    cause: 'The Business Continuity Plan was triggered and your position was handed to a successor.',
    fix: 'Contact your organisation owner. They can either restore your position or onboard you to a new role.'
  },
  {
    problem: '"Account inactive" message after login',
    cause: 'An admin set your status to inactive (commonly during offboarding).',
    fix: 'Contact your organisation owner. If you were offboarded by mistake, they can reactivate you on the Employees page.'
  },
  {
    problem: 'I uploaded a logo but it doesn\'t appear in the PDF',
    cause: 'The logo URL was a session-only browser URL (blob:), which Puppeteer cannot read from the server.',
    fix: 'Re-upload the logo through the Organisation Information page. Stewardex stores it as a base64 data URL so PDFs always have access to it.'
  },
  {
    problem: 'The Approval Flow diagram shows my name as "Unassigned"',
    cause: 'The position is configured but no active board member holds it.',
    fix: 'Open Charity Administration → Responsible People → Add or assign someone to that position.'
  },
  {
    problem: 'I can\'t see the Permissions menu',
    cause: 'You\'re not an admin — only admins see Permissions and Workflows.',
    fix: 'If you should be an admin, ask your organisation owner to elevate you. There\'s only ever one organisation owner per tenant.'
  },
  {
    problem: 'My MFA code keeps saying "expired"',
    cause: 'Your authenticator app\'s clock has drifted from real time.',
    fix: 'Resync the clock in the authenticator app (Google Authenticator → Settings → Time correction → Sync now).'
  },
  {
    problem: 'I can\'t download a PDF — page just hangs',
    cause: 'PDF generation runs server-side and can take 10-20 seconds for large reports.',
    fix: 'Wait at least 30 seconds. If still hanging, check your network tab for an error response and contact support with the request ID.'
  },
  {
    problem: 'Email reminders not arriving',
    cause: 'Either the email is being filtered as spam, or your contact email is wrong.',
    fix: 'Check spam/junk for emails from your Stewardex sender address. Update your contact email under Profile → Account if needed.'
  },
  {
    problem: 'Public link (COI form / volunteer form) shows "Invalid token"',
    cause: 'Public-form tokens expire after a fixed window (usually 30 days).',
    fix: 'Re-issue the link from inside Stewardex — old links can\'t be reactivated.'
  },
  {
    problem: 'Heat map shows nothing despite risks being on the register',
    cause: 'Period filter is restricting the view. Or risks have no consequence/likelihood set.',
    fix: 'Click the "Period" dropdown above the KPIs and pick "All time". If still empty, edit each risk and assign a 1-5 score for both consequence and likelihood.'
  },
  {
    problem: 'Chat messages aren\'t arriving in real time',
    cause: 'WebSocket connection dropped (firewall, proxy, or laptop sleep).',
    fix: 'Refresh the page — the socket reconnects on load. If your office firewall blocks WebSockets, ask IT to allow `wss://` to your Stewardex domain.'
  }
];

const FAQ = [
  ['How many users can my organisation have?', 'There\'s no fixed user cap on the platform itself. Your subscription plan determines billing — contact us if you need to scale up.'],
  ['How do I add an admin?', 'There\'s exactly one organisation owner per tenant (the person who signed up). To grant similar privileges to others, give them a position with broad module permissions, or work with our support team for a co-owner setup.'],
  ['How do I reset my MFA?', 'Email support with your registered email. We\'ll verify your identity and reset MFA so you can re-enrol.'],
  ['Can I export my data?', 'Yes. Every module supports CSV / PDF export for the records visible to you. For a full tenant export, raise a support ticket — it\'s a one-time bulk dump.'],
  ['Where is my data hosted?', 'AWS Sydney (ap-southeast-2). Each tenant has its own isolated MongoDB database.'],
  ['How is sensitive data protected?', 'Field-level AES-256-GCM encryption for fields like ABN, Director ID, email, and address. The master key is held in a secrets manager separate from the database.'],
  ['What happens if a board member leaves?', 'Open Charity Administration → Responsible People → Off-board the person. Stewardex flags any positions they held as needing succession; you can reassign or close the role.'],
  ['Can auditors see everything?', 'Auditors see read-only views across every module. They can\'t approve, edit, delete, or upload — every mutating action is blocked at both the frontend (axios interceptor) and the backend (auditor write-guard middleware).'],
  ['What\'s the difference between a position and a person?', 'A position is the role definition (e.g. "Treasurer"). A person fills that position via a BoardMember record. Permissions live on the position — the person inherits them while they hold the role.'],
  ['How does field-level encryption affect search?', 'Encrypted fields with `searchable: true` get a blind-index hash so we can find exact matches without decryption. Partial / fuzzy search on encrypted fields is not supported.'],
  ['How often are reminders sent?', 'Most reminders are 30 / 14 / 7 / 1 days before the due date. Some modules also send a final-day reminder. Reminders run on a daily background scheduler.'],
  ['Does Stewardex submit my AIS / BAS / fiscal reports?', 'No — Stewardex generates the artefacts and tracks lodgement, but you submit through the ACNC / ATO portals. We\'ll automate lodgement in a future release.'],
  ['Can I use a custom approval workflow per department?', 'Yes. Approval matrices are scoped per category, and within a category you can define multiple matrices that route on amount, department, or risk level.'],
  ['What browsers are supported?', 'Latest two versions of Chrome, Edge, Firefox, and Safari. We don\'t support Internet Explorer.'],
  ['Is there an API?', 'Not publicly. Internal modules consume a REST API but it\'s not yet documented for external integration. Contact us about partnership tiers.'],
  ['What does "tenant" mean?', 'Your organisation\'s isolated workspace. Each tenant has its own database, its own users, and its own data — there\'s no cross-tenant leakage.'],
  ['Can I trial Stewardex before buying?', 'Yes. Reach out and we\'ll provision a sandbox tenant pre-loaded with example data so you can see the full platform.'],
  ['Where do I get help during onboarding?', 'Email support, raise a support ticket from inside Stewardex, or use the in-platform chat with the customer-success team during business hours.']
];

// ---------- HTML builder ----------

function buildHandbookHtml({ org, logoSrc }) {
  const charityName = esc(org?.trading_name || org?.name || 'Your Charity');
  const abn = esc(org?.abn || '—');
  const acncReg = esc(org?.acnc_registration_number || '—');
  const today = formatDate();

  const tocItems = [
    ['Welcome', 'welcome'],
    ['Pre-flight checklist — what you need before starting', 'preflight'],
    ['First-time setup walkthrough', 'setup'],
    ['Module guide', 'modules'],
    ...MODULES.map((m) => [`  · ${m.title}`, `module-${m.id}`]),
    ['Roles & permissions deep dive', 'permissions-deep'],
    ['Approval workflows deep dive', 'workflows-deep'],
    ['Glossary of terms', 'glossary'],
    ['Troubleshooting', 'troubleshooting'],
    ['FAQ', 'faq'],
    ['Support & contact', 'support']
  ];

  const moduleSectionsHtml = MODULES.map((m) => `
    <section class="page" id="module-${m.id}">
      <div class="module-eyebrow">Module</div>
      <h1 class="section-h1">${esc(m.title)}</h1>
      <p class="lead">${esc(m.purpose)}</p>
      <div class="how-to">
        <div class="how-to-title">How to use it</div>
        <ol>
          ${m.use.map((step) => `<li>${esc(step)}</li>`).join('')}
        </ol>
      </div>
      <div class="callout tip">
        <div class="callout-title">Tip</div>
        <div>${esc(m.tips)}</div>
      </div>
    </section>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Stewardex Onboarding Handbook — ${charityName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Lora:ital,wght@0,400;0,600;1,400&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --brand-deep: #0A2E3F;
    --brand-azure: #117A8B;
    --ink: #0F172A;
    --ink-2: #334155;
    --ink-3: #64748B;
    --ink-4: #94A3B8;
    --line: #E2E8F0;
    --line-2: #CBD5E1;
    --paper: #F8FAFC;
    --paper-2: #F1F5F9;
    --gradient: linear-gradient(135deg, var(--brand-deep) 0%, var(--brand-azure) 100%);
    --gradient-soft: linear-gradient(135deg, rgba(10,46,63,0.06), rgba(17,122,139,0.06));
  }

  html, body { font-family: 'Inter', sans-serif; color: var(--ink); font-size: 11pt; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { background: #fff; }

  /* Each .page is a separate printed page, not a fixed CSS page-size; lets
     content flow naturally while honouring section starts. */
  .page { padding: 60px 64px 80px; min-height: 1080px; position: relative; page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  /* ---- Cover ---- */
  .cover {
    background: var(--gradient);
    color: #fff;
    min-height: 1200px;
    padding: 72px 64px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    page-break-after: always;
    overflow: hidden;
    position: relative;
  }
  .cover::before {
    content: '';
    position: absolute;
    top: -200px; right: -200px;
    width: 600px; height: 600px;
    background: radial-gradient(circle, rgba(255,255,255,0.12) 0%, transparent 70%);
    pointer-events: none;
  }
  .cover::after {
    content: '';
    position: absolute;
    bottom: -180px; left: -180px;
    width: 520px; height: 520px;
    background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
    pointer-events: none;
  }
  .cover-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .cover-mark { width: 220px; }
  .cover-org-logo { max-height: 96px; max-width: 240px; background: rgba(255,255,255,0.94); padding: 14px 18px; border-radius: 12px; }
  .cover-mid {
    display: flex; flex-direction: column; gap: 18px;
  }
  .cover-eyebrow { font-size: 11pt; letter-spacing: 0.32em; text-transform: uppercase; font-weight: 700; opacity: 0.78; }
  .cover-title { font-family: 'Lora', serif; font-size: 60pt; line-height: 1.0; font-weight: 600; letter-spacing: -1.5px; }
  .cover-sub { font-size: 15pt; opacity: 0.92; max-width: 680px; line-height: 1.45; font-weight: 300; }
  .cover-org { padding-top: 28px; border-top: 1px solid rgba(255,255,255,0.28); display: flex; flex-direction: column; gap: 6px; }
  .cover-org-name { font-size: 18pt; font-weight: 700; }
  .cover-org-meta { font-size: 10pt; opacity: 0.78; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
  .cover-org .cover-org-logo {
    max-height: 64px; max-width: 220px; background: rgba(255,255,255,0.92);
    padding: 8px 12px; border-radius: 8px; align-self: flex-start; margin-top: 4px;
  }
  .cover-bottom { display: flex; justify-content: space-between; align-items: center; gap: 16px; font-size: 10pt; opacity: 0.85; }

  /* ---- Section / chapter dividers ---- */
  .section-title-page {
    background: var(--gradient);
    color: #fff;
    min-height: 1080px;
    padding: 64px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    page-break-after: always;
  }
  .section-title-page .num { font-size: 10pt; letter-spacing: 0.32em; text-transform: uppercase; opacity: 0.85; font-weight: 700; }
  .section-title-page h1 { font-family: 'Lora', serif; font-size: 48pt; font-weight: 600; line-height: 1.05; letter-spacing: -0.5px; margin-top: 12px; }
  .section-title-page .blurb { margin-top: 16px; font-size: 14pt; opacity: 0.92; max-width: 620px; line-height: 1.5; font-weight: 300; }

  /* ---- Inline section heads ---- */
  .module-eyebrow { font-size: 9pt; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700; color: var(--brand-azure); margin-bottom: 6px; }
  .section-h1 {
    font-family: 'Lora', serif;
    font-size: 26pt;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.4px;
    margin-bottom: 10px;
    line-height: 1.1;
  }
  .section-h1 + .lead {
    color: var(--ink-2);
    font-size: 13pt;
    margin-bottom: 22px;
    max-width: 620px;
    line-height: 1.5;
  }
  h2.section-h2 {
    font-family: 'Lora', serif;
    font-size: 18pt;
    font-weight: 600;
    color: var(--ink);
    margin: 26px 0 8px;
    letter-spacing: -0.2px;
  }
  h3.section-h3 {
    font-size: 12.5pt;
    font-weight: 700;
    color: var(--ink);
    margin: 18px 0 6px;
  }

  p { margin: 0 0 10px; color: var(--ink-2); font-size: 11pt; line-height: 1.6; }
  p strong { color: var(--ink); font-weight: 700; }
  ul, ol { margin: 8px 0 14px 22px; padding: 0; color: var(--ink-2); }
  ul li, ol li { margin: 4px 0; line-height: 1.55; font-size: 11pt; }
  ul li::marker { color: var(--brand-azure); }
  ol li::marker { color: var(--brand-azure); font-weight: 600; }

  /* ---- Callouts ---- */
  .callout {
    margin: 16px 0;
    padding: 14px 18px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--paper);
    font-size: 10.5pt;
    color: var(--ink-2);
    line-height: 1.55;
    page-break-inside: avoid;
  }
  .callout .callout-title {
    font-size: 9pt;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .callout.tip { background: linear-gradient(135deg, #ECFDF5, #F0FDF4); border-color: #BBF7D0; }
  .callout.tip .callout-title { color: #166534; }
  .callout.note { background: linear-gradient(135deg, #EFF6FF, #F0F9FF); border-color: #BFDBFE; }
  .callout.note .callout-title { color: #1E40AF; }
  .callout.warn { background: linear-gradient(135deg, #FFFBEB, #FEF3C7); border-color: #FDE68A; }
  .callout.warn .callout-title { color: #92400E; }
  .callout.brand { background: var(--gradient-soft); border-color: rgba(17,122,139,0.25); }
  .callout.brand .callout-title { color: var(--brand-deep); }

  /* ---- How-to box ---- */
  .how-to {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px 22px;
    margin: 12px 0 16px;
    page-break-inside: avoid;
  }
  .how-to-title {
    font-size: 9pt;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--brand-deep);
    margin-bottom: 8px;
  }
  .how-to ol { margin: 0 0 0 22px; }

  /* ---- Pre-flight checklist groups ---- */
  .preflight-group { margin: 18px 0 4px; }
  .preflight-group-title {
    font-size: 11pt;
    font-weight: 700;
    color: var(--brand-deep);
    letter-spacing: 0.04em;
    margin-bottom: 8px;
  }
  .preflight-table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .preflight-table tr:not(:last-child) td { border-bottom: 1px solid var(--line); }
  .preflight-table td { padding: 10px 14px; font-size: 10.5pt; vertical-align: top; }
  .preflight-table td.label { width: 36%; font-weight: 600; color: var(--ink); background: var(--paper); }
  .preflight-table td.desc { color: var(--ink-2); }

  /* ---- TOC ---- */
  .toc-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 0;
    font-size: 11pt;
    color: var(--ink-2);
  }
  .toc-row .lbl { font-weight: 600; color: var(--ink); }
  .toc-row.is-sub .lbl { font-weight: 400; color: var(--ink-2); padding-left: 12px; }
  .toc-row .dots {
    flex: 1;
    border-bottom: 1px dotted var(--ink-4);
    margin: 0 6px;
    transform: translateY(-3px);
  }
  .toc-row .pg { font-variant-numeric: tabular-nums; color: var(--ink-3); font-size: 10pt; }

  /* ---- Glossary ---- */
  .glossary {
    columns: 2;
    column-gap: 28px;
    column-rule: 1px solid var(--line);
    margin-top: 14px;
  }
  .glossary-item {
    break-inside: avoid;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--paper-2);
  }
  .glossary-term { font-weight: 700; color: var(--brand-deep); font-size: 10.5pt; }
  .glossary-def { color: var(--ink-2); font-size: 10pt; line-height: 1.45; margin-top: 2px; }

  /* ---- Troubleshooting / FAQ ---- */
  .qa-block {
    margin: 14px 0;
    padding: 16px 20px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #FFF;
    page-break-inside: avoid;
  }
  .qa-block .q { font-weight: 700; color: var(--ink); font-size: 11.5pt; margin-bottom: 6px; }
  .qa-block .meta { font-size: 9pt; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 700; color: var(--brand-azure); margin-bottom: 4px; }
  .qa-block .body { color: var(--ink-2); font-size: 10.5pt; line-height: 1.55; }
  .qa-block .body strong { color: var(--ink); }

  /* ---- Footer (per page) ---- */
  .pg-footer {
    position: absolute;
    bottom: 26px;
    left: 64px;
    right: 64px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 9pt;
    color: var(--ink-3);
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .pg-footer .stamp { display: inline-flex; align-items: center; gap: 6px; }
  .pg-footer .stamp svg { width: 60px; height: auto; }

  /* ---- Hierarchy diagram on cover ---- */
  .hero-art {
    margin-top: 28px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .hero-pill {
    background: rgba(255,255,255,0.16);
    border: 1px solid rgba(255,255,255,0.30);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 10pt;
    font-weight: 600;
    color: #fff;
    backdrop-filter: blur(8px);
  }

  /* ---- Setup walkthrough ---- */
  .step {
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 18px 22px;
    margin-bottom: 14px;
    background: linear-gradient(135deg, #FFFFFF, var(--paper));
    page-break-inside: avoid;
  }
  .step-num {
    display: inline-flex;
    align-items: center; justify-content: center;
    width: 30px; height: 30px;
    border-radius: 8px;
    background: var(--gradient);
    color: #fff;
    font-weight: 700;
    font-size: 11pt;
    margin-right: 10px;
  }
  .step-head {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
  }
  .step-title { font-size: 14pt; font-weight: 700; color: var(--ink); }

  .role-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-top: 14px;
  }
  .role-card {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px;
    page-break-inside: avoid;
  }
  .role-card .name { font-weight: 700; color: var(--brand-deep); margin-bottom: 4px; font-size: 11pt; }
  .role-card .desc { color: var(--ink-2); font-size: 10pt; line-height: 1.5; }
</style>
</head>
<body>

  <!-- ============== COVER ============== -->
  <section class="cover">
    <div class="cover-top">
      <div class="cover-mark">${STEWARDEX_WORDMARK_SVG}</div>
    </div>

    <div class="cover-mid">
      <div class="cover-eyebrow">The Definitive Guide</div>
      <div class="cover-title">The Stewardex<br/>Handbook.</div>
      <div class="cover-sub">A complete reference to the Stewardex platform — every module, every hierarchy, every workflow. Designed for Australian charities, governance teams, and compliance professionals.</div>

      <div class="hero-art">
        <span class="hero-pill">Governance</span>
        <span class="hero-pill">Approvals</span>
        <span class="hero-pill">Risk</span>
        <span class="hero-pill">Reporting</span>
        <span class="hero-pill">People & HR</span>
        <span class="hero-pill">Finance</span>
        <span class="hero-pill">Funding</span>
        <span class="hero-pill">Audit Trail</span>
      </div>

      <div class="cover-org">
        <div class="cover-org-meta">Prepared for</div>
        <div class="cover-org-name">${charityName}</div>
        ${logoSrc ? `<img src="${logoSrc}" alt="${charityName}" class="cover-org-logo" />` : ''}
        <div class="cover-org-meta">${abn !== '—' ? `ABN ${abn} · ` : ''}${acncReg !== '—' ? `ACNC ${acncReg} · ` : ''}Issued ${esc(today)}</div>
      </div>
    </div>

    <div class="cover-bottom">
      <span>Stewardex Product Handbook</span>
      <span>v1.0 · Confidential</span>
    </div>
  </section>

  <!-- ============== TOC ============== -->
  <section class="page">
    <div class="module-eyebrow">Contents</div>
    <h1 class="section-h1">What's inside</h1>
    <p class="lead">A quick map so you can jump to any topic, any time.</p>

    ${tocItems.map(([label, anchor], idx) => {
      const isSub = label.startsWith('  ·');
      const cleanLabel = label.replace(/^\s*·\s*/, '');
      return `<div class="toc-row${isSub ? ' is-sub' : ''}">
        <span class="lbl">${esc(cleanLabel)}</span>
        <span class="dots"></span>
        <span class="pg">§ ${idx + 1}</span>
      </div>`;
    }).join('')}

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · Contents</span>
    </div>
  </section>

  <!-- ============== WELCOME ============== -->
  <section class="section-title-page" id="welcome">
    <div class="num">Section 1</div>
    <h1>Welcome.</h1>
    <p class="blurb">Stewardex is a single platform for everything a registered Australian charity needs to operate well — governance, compliance, finance, people, reporting. This first chapter is the big picture.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Welcome</div>
    <h1 class="section-h1">What Stewardex does</h1>
    <p class="lead">A guided tour of the spine of the platform — the modules, how they connect, and what to expect in your first 30 days.</p>

    <h2 class="section-h2">The four pillars</h2>
    <p>Stewardex is built around four pillars that mirror how Australian charities actually operate. Every module fits under one of them.</p>
    <div class="role-grid">
      <div class="role-card">
        <div class="name">Governance</div>
        <div class="desc">Charity Administration, Organisation Chart, Policies, Approval Workflows, Conflict of Interest, Audit Trail, Legal Documents, IT System Register.</div>
      </div>
      <div class="role-card">
        <div class="name">Operations</div>
        <div class="desc">People & HR, Volunteers, Risk Management, Cash Handling, Access Control & Offboarding, Complaints.</div>
      </div>
      <div class="role-card">
        <div class="name">Funding & Finance</div>
        <div class="desc">Financial Controls, Sweep Funds, Donor Register, Marketing, Project Delivery, Refunds, Grants & Funding Agreements.</div>
      </div>
      <div class="role-card">
        <div class="name">Reporting</div>
        <div class="desc">Weekly board reports, Fiscal Reports, BAS Lodgement, AIS Wizard, ACNC Annual Financial Report.</div>
      </div>
    </div>

    <h2 class="section-h2">How modules connect</h2>
    <p>Modules aren't silos. Here's how data flows between them so you don't have to type things twice.</p>
    <ul>
      <li><strong>Governance Structure</strong> (departments + positions) drives the <strong>Organisation Chart</strong>, the <strong>Approval Workflow</strong> matrices, and the <strong>Permissions</strong> system.</li>
      <li><strong>Responsible People</strong> records feed the <strong>Audit Trail</strong>, the AIS report, the COI register, and the BCP succession plan.</li>
      <li><strong>Approval Workflows</strong> sit on top of every action that needs sign-off — Expense, Risk Treatment, Policy, Sweep Funds, BAS, AIS.</li>
      <li><strong>Audit Trail</strong> is the universal append-only log that stitches it all together; every approval / edit / upload writes a row.</li>
    </ul>

    <div class="callout brand">
      <div class="callout-title">First 30 days · what to do</div>
      <div>Week 1: complete the 5-step onboarding wizard. Week 2: configure approval workflows for your most-used categories (Expense, Policy). Week 3: invite your team and run your first board meeting through the platform. Week 4: lodge your first BAS and review your first risk register heat map.</div>
    </div>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Welcome</span>
    </div>
  </section>

  <!-- ============== PRE-FLIGHT ============== -->
  <section class="section-title-page" id="preflight">
    <div class="num">Section 2</div>
    <h1>Pre-flight checklist.</h1>
    <p class="blurb">The information you'll want on hand before you sit down to set Stewardex up. Most can be gathered in an hour by your operations or governance lead.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Pre-flight</div>
    <h1 class="section-h1">What you need before starting</h1>
    <p class="lead">Five quick groups. Tick each one off — it'll save you reopening setup later to add a missing field.</p>

    ${PRE_FLIGHT.map((g) => `
      <div class="preflight-group">
        <div class="preflight-group-title">${esc(g.group)}</div>
        <table class="preflight-table">
          ${g.items.map(([label, desc]) => `
            <tr>
              <td class="label">${esc(label)}</td>
              <td class="desc">${esc(desc)}</td>
            </tr>
          `).join('')}
        </table>
      </div>
    `).join('')}

    <div class="callout note">
      <div class="callout-title">Don't have it all yet?</div>
      <div>You can start with the Identity + Tax groups and fill in the rest later. Stewardex won't block you — overdue prompts will appear on your Dashboard until each item is complete.</div>
    </div>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Pre-flight</span>
    </div>
  </section>

  <!-- ============== SETUP WALKTHROUGH ============== -->
  <section class="section-title-page" id="setup">
    <div class="num">Section 3</div>
    <h1>First-time setup.</h1>
    <p class="blurb">A guided 5-step wizard runs the first time the organisation owner logs in. Every step is editable later — don't worry about getting it perfect on day one.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Setup</div>
    <h1 class="section-h1">The 5-step onboarding wizard</h1>
    <p class="lead">Sign in → the wizard appears → complete in roughly 30 minutes. You can skip and return at any point; progress is saved per step.</p>

    <div class="step">
      <div class="step-head"><span class="step-num">1</span><span class="step-title">Organisation details</span></div>
      <p>Enter legal name, trading name, ABN, ACN (if applicable), ACNC registration number, address, contact email, financial-year end, and upload your logo. The logo will appear on every PDF Stewardex generates for you.</p>
    </div>
    <div class="step">
      <div class="step-head"><span class="step-num">2</span><span class="step-title">Governing documents</span></div>
      <p>Upload your constitution (or rule book), code of conduct, and any other governing instruments. Each document gets a category and a review schedule.</p>
    </div>
    <div class="step">
      <div class="step-head"><span class="step-num">3</span><span class="step-title">Responsible people</span></div>
      <p>Add every trustee/director: name, position, email, Director ID, start date, and any suitability documents (police checks, working with children checks, qualifications).</p>
    </div>
    <div class="step">
      <div class="step-head"><span class="step-num">4</span><span class="step-title">Financial controls</span></div>
      <p>Define your bank accounts and the signatories per account. Set the dollar thresholds that determine which approval matrix kicks in for expenses (e.g. up to $1k = Treasurer; over $5k = Treasurer + CEO; over $20k = board).</p>
    </div>
    <div class="step">
      <div class="step-head"><span class="step-num">5</span><span class="step-title">Declaration</span></div>
      <p>The organisation owner signs the declaration confirming the information is true and correct. The signed declaration is stored in the Audit Trail.</p>
    </div>

    <div class="callout warn">
      <div class="callout-title">Until setup is complete</div>
      <div>The sidebar collapses to a minimal view (Dashboard + setup steps) until all five steps are done. This is intentional — it forces customers to finish onboarding before exploring deeper modules. Click "Skip for now" on the Dashboard banner if you want to bypass during a sandbox demo.</div>
    </div>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Setup</span>
    </div>
  </section>

  <!-- ============== MODULE GUIDE ============== -->
  <section class="section-title-page" id="modules">
    <div class="num">Section 4</div>
    <h1>Module guide.</h1>
    <p class="blurb">Every feature, in plain English. Each module gets a single-page rundown — what it's for, how to use it, and the most-common gotcha.</p>
  </section>

  ${moduleSectionsHtml}

  <!-- ============== PERMISSIONS DEEP DIVE ============== -->
  <section class="section-title-page" id="permissions-deep">
    <div class="num">Section 5</div>
    <h1>Roles & permissions deep dive.</h1>
    <p class="blurb">How positions, departments, and module permissions interact — and why we recompute permissions on every request.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Deep dive</div>
    <h1 class="section-h1">Roles & permissions</h1>
    <p class="lead">Stewardex uses a position-based permission model. Permissions live on the position, not on the person — which means a role transfer (e.g. new Treasurer) instantly inherits the right access.</p>

    <h2 class="section-h2">The model</h2>
    <ul>
      <li><strong>Department</strong> groups a set of positions (e.g. Finance contains Treasurer, Bookkeeper).</li>
      <li><strong>Position</strong> is a role definition — has a title, a department, optional reports-to relationship, and a list of module permissions.</li>
      <li><strong>BoardMember / Person</strong> is the actual human, who fills one or more positions over time.</li>
      <li><strong>Module permission</strong> is a tuple of view, edit, delete per module.</li>
      <li><strong>Granted permission</strong> is a string like <code>training:create</code> for action-level rights.</li>
    </ul>

    <h2 class="section-h2">How permissions are computed</h2>
    <p>For non-admin users, permissions are recomputed on <strong>every API request</strong>:</p>
    <ol>
      <li>Look up the user's active BoardMember records (positions held).</li>
      <li>Pull module permissions from each position.</li>
      <li>Merge most-permissive-wins (a position with edit overrides a position with only view).</li>
      <li>Add always-granted modules (Dashboard, Support Tickets) so users never lose those.</li>
    </ol>
    <p>For admins (organisation owner), the JWT is authoritative — they need to log out / in to pick up role changes.</p>

    <div class="callout note">
      <div class="callout-title">Why per-request recompute?</div>
      <div>Because position permissions change quickly (new policies, BCP triggers, role swaps). Caching permissions in the JWT would mean stale access until the next login — unacceptable for governance. The recompute adds ~3ms per request and is worth it.</div>
    </div>

    <h2 class="section-h2">Special-case roles</h2>
    <ul>
      <li><strong>Organisation owner</strong> — exactly one per tenant. Bypasses every check via the <code>*:*</code> wildcard.</li>
      <li><strong>Auditor</strong> — read-only across every module. Mutating actions are blocked at both the frontend axios interceptor and the backend write-guard middleware.</li>
      <li><strong>BCP-transferred</strong> — when a position is transferred to a successor, the original holder gets a 403 POSITION_TRANSFERRED on every request until reactivated.</li>
      <li><strong>Inactive</strong> — user status is "inactive", which returns 403 ACCOUNT_INACTIVE on every request.</li>
    </ul>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Permissions</span>
    </div>
  </section>

  <!-- ============== WORKFLOWS DEEP DIVE ============== -->
  <section class="section-title-page" id="workflows-deep">
    <div class="num">Section 6</div>
    <h1>Approval workflows deep dive.</h1>
    <p class="blurb">Matrices, categories, escalations, rejections, re-attempts — how a request actually moves through Stewardex from submission to final approval.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Deep dive</div>
    <h1 class="section-h1">Approval workflows</h1>
    <p class="lead">Every governance action that needs sign-off goes through a workflow. The workflow is a chain of steps; each step is satisfied by a specific role or named user, in order.</p>

    <h2 class="section-h2">Categories</h2>
    <p>A category is the type of thing being approved. Stewardex ships with categories for: Expense, Policy, Risk Treatment, Sweep Funds, BAS Lodgement, Fiscal Report, AIS, COI Declaration, Project Registration, Funding Agreement, and a few more. Each category can have its own matrix.</p>

    <h2 class="section-h2">Steps</h2>
    <p>A step has:</p>
    <ul>
      <li>An <strong>approver</strong> — either a position (e.g. "CFO") or a specific user.</li>
      <li>A <strong>condition</strong> — when it applies (e.g. "amount &gt; $5,000" or "department = Finance").</li>
      <li>A <strong>SLA</strong> — how long the approver has before escalation kicks in.</li>
    </ul>

    <h2 class="section-h2">The lifecycle</h2>
    <ol>
      <li><strong>Submitted</strong> — request lands; first step's approver is notified.</li>
      <li><strong>Approved at step N</strong> — approver clicks Approve; the request advances to step N+1.</li>
      <li><strong>Final approval</strong> — the underlying record (expense, policy, etc.) becomes active.</li>
      <li><strong>Rejected</strong> — request is declined. Submitter can resubmit (creates a new attempt).</li>
      <li><strong>Escalated</strong> — approver requests a second opinion from another approver before deciding.</li>
      <li><strong>Forwarded</strong> — a rejection can be forwarded for review by a third party.</li>
      <li><strong>Paused for COI</strong> — if the approver has a recorded COI on the entity, the request auto-pauses for COI review.</li>
    </ol>

    <h2 class="section-h2">The visual trail</h2>
    <p>Open any approval and scroll to the "Approval flow" panel. You'll see a horizontal flow with:</p>
    <ul>
      <li><strong>Position</strong> (label) — the role responsible for that step.</li>
      <li><strong>Person name</strong> — the actual reviewer assigned to the step.</li>
      <li><strong>Status</strong> + <strong>timestamp</strong> — Approved, Awaiting, Declined, Re-attempt, Under review.</li>
    </ul>

    <div class="callout warn">
      <div class="callout-title">"Workflow not configured"</div>
      <div>If you submit something whose category has no matrix, you'll see a guard dialog. Click "Open workflow setup" to configure one. Until then, the request can't progress — there's no chain to walk.</div>
    </div>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Workflows</span>
    </div>
  </section>

  <!-- ============== GLOSSARY ============== -->
  <section class="section-title-page" id="glossary">
    <div class="num">Section 7</div>
    <h1>Glossary.</h1>
    <p class="blurb">The vocabulary you'll see across the platform — both Stewardex-specific terms and the standard Australian charity / ATO acronyms.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Glossary</div>
    <h1 class="section-h1">Terms you'll encounter</h1>
    <p class="lead">Alphabetical. Use as a reference whenever an acronym shows up that you'd like to double-check.</p>

    <div class="glossary">
      ${GLOSSARY.map(([term, def]) => `
        <div class="glossary-item">
          <div class="glossary-term">${esc(term)}</div>
          <div class="glossary-def">${esc(def)}</div>
        </div>
      `).join('')}
    </div>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Glossary</span>
    </div>
  </section>

  <!-- ============== TROUBLESHOOTING ============== -->
  <section class="section-title-page" id="troubleshooting">
    <div class="num">Section 8</div>
    <h1>Troubleshooting.</h1>
    <p class="blurb">The most-common stumbles, with the cause and the fix laid out plainly. Save this section for the next time something doesn't behave the way you expect.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Troubleshooting</div>
    <h1 class="section-h1">If something isn't working</h1>
    <p class="lead">Find the symptom that matches yours — each block has the cause and the resolution.</p>

    ${TROUBLESHOOTING.map((t) => `
      <div class="qa-block">
        <div class="meta">Symptom</div>
        <div class="q">${esc(t.problem)}</div>
        <div class="body"><strong>Cause:</strong> ${esc(t.cause)}<br/><strong>Fix:</strong> ${esc(t.fix)}</div>
      </div>
    `).join('')}

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § Troubleshooting</span>
    </div>
  </section>

  <!-- ============== FAQ ============== -->
  <section class="section-title-page" id="faq">
    <div class="num">Section 9</div>
    <h1>Frequently asked.</h1>
    <p class="blurb">Top questions from our customers — billing, security, data, integrations, and the practical "how do I…" prompts that come up over and over.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">FAQ</div>
    <h1 class="section-h1">Common questions</h1>
    <p class="lead">A quick scan should cover almost everything. If the answer isn't here, the Support section on the next page tells you how to reach us.</p>

    ${FAQ.map(([q, a]) => `
      <div class="qa-block">
        <div class="meta">Q</div>
        <div class="q">${esc(q)}</div>
        <div class="body"><strong>A.</strong> ${esc(a)}</div>
      </div>
    `).join('')}

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · § FAQ</span>
    </div>
  </section>

  <!-- ============== SUPPORT ============== -->
  <section class="section-title-page" id="support">
    <div class="num">Section 10</div>
    <h1>Support &amp; contact.</h1>
    <p class="blurb">Everything you need to reach us — channels, hours, expected response times, and how to raise a ticket from inside Stewardex.</p>
  </section>

  <section class="page">
    <div class="module-eyebrow">Support</div>
    <h1 class="section-h1">How to reach us</h1>
    <p class="lead">We aim to acknowledge every support enquiry within one business day, and resolve standard issues within three business days.</p>

    <h2 class="section-h2">Channels</h2>
    <div class="role-grid">
      <div class="role-card">
        <div class="name">In-app support ticket</div>
        <div class="desc">Sidebar → Support Tickets → New ticket. Best for non-urgent questions; we get the full context of your tenant and can investigate without a back-and-forth.</div>
      </div>
      <div class="role-card">
        <div class="name">Email</div>
        <div class="desc">Reply to your onboarding email or the address on your invoice. Useful when you can't sign in or need to reset MFA.</div>
      </div>
      <div class="role-card">
        <div class="name">In-platform chat</div>
        <div class="desc">During business hours, the customer-success team is available in the in-app chat for live questions.</div>
      </div>
      <div class="role-card">
        <div class="name">Phone</div>
        <div class="desc">Available to customers on Pro and Enterprise plans for incidents that need real-time triage.</div>
      </div>
    </div>

    <h2 class="section-h2">Hours</h2>
    <p>Sydney business hours, Monday to Friday, 9:00 to 17:30 AEST/AEDT. For incidents flagged as critical (e.g. lockout from your tenant), we monitor an after-hours pager.</p>

    <h2 class="section-h2">SLA expectations</h2>
    <ul>
      <li><strong>Critical</strong> — tenant inaccessible: 1-hour acknowledgement, 4-hour resolution target.</li>
      <li><strong>High</strong> — feature broken affecting multiple users: same-day acknowledgement, 2-business-day resolution target.</li>
      <li><strong>Standard</strong> — questions, configuration help: 1-business-day acknowledgement, 3-business-day resolution target.</li>
      <li><strong>Enhancement</strong> — feature requests: triaged into the roadmap; we'll respond with a likely timeframe.</li>
    </ul>

    <div class="callout brand">
      <div class="callout-title">One last thing</div>
      <div>Welcome to the platform. The Stewardex team is genuinely glad you're here — Australia's charity sector runs on the goodwill of its people, and we built this platform to give them the tooling they deserve. If anything in this handbook is unclear, that's our fault — please tell us, and we'll fix it.</div>
    </div>

    <div class="pg-footer">
      <span class="stamp">${STEWARDEX_WORDMARK_SVG}</span>
      <span>The Stewardex Handbook · End of document</span>
    </div>
  </section>

</body>
</html>`;
}

/**
 * Render the handbook to a PDF buffer.
 */
export async function generateOnboardingHandbookPdf({ org } = {}) {
  const logoSrc = await resolveLogoSrcForPdf(org?.logo_url);
  const html = buildHandbookHtml({ org: org || {}, logoSrc });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 0 });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
    return buffer;
  } finally {
    await browser.close();
  }
}
