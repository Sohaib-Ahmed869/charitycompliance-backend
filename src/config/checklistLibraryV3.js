/**
 * Checklist Library v3 — Optimised from 110 source → 50 checklists
 *
 * Source: checklists_v3_clean.xlsx
 * 10 Global (G01–G10): cross-cutting governance checklists applied across all modules
 * 40 Item-wise (I01–I40): per-transaction / per-record checklists
 *
 * Each entry carries:
 *   - v3Id: stable idempotency key (G01, I15, etc.)
 *   - name, description, category, module
 *   - checklistType: 'global' | 'item_wise'
 *   - entityTargets: array of canonical entity types this checklist should bind to
 *   - items: the 4–5 compliance check points from the xlsx
 */

// ─── Global Checklists (G01–G10) ────────────────────────────────────────────

export const GLOBAL_CHECKLISTS = [
  {
    v3Id: 'G01',
    name: 'Governance & Responsible Persons',
    checklistType: 'global',
    category: 'Governance',
    module: 'Governance',
    description: 'Board register, fit-and-proper checks, COI, delegations',
    entityTargets: [],
    items: [
      { title: 'The current board and responsible person register has been maintained.', sortOrder: 10 },
      { title: 'The fit-and-proper checks (police/WWCC where required) have been validated.', sortOrder: 20 },
      { title: 'The ACNC disqualification check has been performed on appointment and at annual review.', sortOrder: 25 },
      { title: 'Conflicts of interest declarations have been recorded.', sortOrder: 30 },
      { title: 'Board member declarations (COI, fit-and-proper) have been signed annually.', sortOrder: 35 },
      { title: 'The governance roles and delegations have been confirmed as current.', sortOrder: 40 },
      { title: 'Governance changes have been tracked and approved.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G02',
    name: 'Policy Lifecycle & Version Control',
    checklistType: 'global',
    category: 'Governance',
    module: 'Governance',
    description: 'Policy owner, review dates, distribution, versioning',
    entityTargets: [],
    items: [
      { title: 'The policy owner and version metadata have been confirmed.', sortOrder: 10 },
      { title: 'The review/approval date and authority have been validated.', sortOrder: 20 },
      { title: 'The policy distribution and acknowledgement workflow has been ensured.', sortOrder: 30 },
      { title: 'Staff and volunteers have acknowledged that they have read and understood the policy.', sortOrder: 35 },
      { title: 'Superseded versions have been archived with traceability.', sortOrder: 40 },
      { title: 'Exceptions and remediation actions have been recorded.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G03',
    name: 'Regulatory Compliance & ACNC Reporting',
    checklistType: 'global',
    category: 'Compliance',
    module: 'Compliance',
    description: 'Registrations, AIS inputs, statutory deadlines, evidence',
    entityTargets: [],
    items: [
      { title: 'The registrations, licences, and permits have been confirmed as active.', sortOrder: 10 },
      { title: 'The annual information statement inputs have been completed.', sortOrder: 20 },
      { title: 'The statutory reporting deadlines have been validated.', sortOrder: 30 },
      { title: 'The evidence pack for regulator submissions has been retained.', sortOrder: 40 },
      { title: 'Late items and corrective actions have been logged.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G04',
    name: 'Audit and Assurance',
    checklistType: 'global',
    category: 'Audit',
    module: 'Audit',
    description: 'Annual audit plan, findings, remediation tracking',
    entityTargets: [],
    items: [
      { title: 'The annual internal audit plan has been defined.', sortOrder: 10 },
      { title: 'External audit readiness evidence has been tracked.', sortOrder: 20 },
      { title: 'Findings have been logged by severity and owner.', sortOrder: 30 },
      { title: 'The remediation closure status has been monitored.', sortOrder: 40 },
      { title: 'The quarterly assurance summary has been produced.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G05',
    name: 'Risk Register & Treatment Oversight',
    checklistType: 'global',
    category: 'Risk',
    module: 'Risk',
    description: 'Risk owner, treatment plan, residual review, escalation',
    entityTargets: [],
    items: [
      { title: 'The risk owner and category have been assigned.', sortOrder: 10 },
      { title: 'The responsible person has been confirmed and the suitability check is current.', sortOrder: 15 },
      { title: 'The risk appetite statement has been approved by the Board.', sortOrder: 18 },
      { title: 'The treatment plan and due dates have been validated.', sortOrder: 20 },
      { title: 'Residual risk review outcomes have been recorded.', sortOrder: 30 },
      { title: 'High and extreme risks have been reviewed by the Board at each meeting.', sortOrder: 35 },
      { title: 'Overdue critical treatments have been escalated.', sortOrder: 40 },
      { title: 'Emerging risks from incidents and complaints have been triaged into the register within 14 days.', sortOrder: 45 },
      { title: 'The next review date has been confirmed.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G06',
    name: 'Financial Controls & Delegations',
    checklistType: 'global',
    category: 'Finance',
    module: 'Finance',
    description: 'Approval thresholds, segregation of duties, reconciliation',
    entityTargets: [],
    items: [
      { title: 'The approval thresholds and signatories have been validated.', sortOrder: 10 },
      { title: 'The segregation of duties for the payment flow has been confirmed.', sortOrder: 20 },
      { title: 'Exception approvals have been verified as documented.', sortOrder: 30 },
      { title: 'The reconciliation and close controls have been checked.', sortOrder: 40 },
      { title: 'Anti-fraud controls (dual sign-off, transaction monitoring) are in place.', sortOrder: 45 },
      { title: 'Periodic control testing has been tracked.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G07',
    name: 'Security, Access & Data Protection',
    checklistType: 'global',
    category: 'IT/Security',
    module: 'IT/Security',
    description: 'User access, MFA, backup, security incidents',
    entityTargets: [],
    items: [
      { title: 'User access has been validated by role and least privilege.', sortOrder: 10 },
      { title: 'MFA and credential policy compliance has been confirmed.', sortOrder: 20 },
      { title: 'Privileged access changes have been recorded.', sortOrder: 30 },
      { title: 'Data encryption is in place for sensitive information at rest and in transit.', sortOrder: 35 },
      { title: 'The backup and retention controls have been confirmed.', sortOrder: 40 },
      { title: 'Security incidents and follow-up have been tracked.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G08',
    name: 'Complaints, Whistleblowing & Non-Conformance',
    checklistType: 'global',
    category: 'Complaints',
    module: 'Complaint',
    description: 'Register, severity, investigation, lessons learned',
    entityTargets: [],
    items: [
      { title: 'The complaint or non-conformance entry has been registered for completeness.', sortOrder: 10 },
      { title: 'The severity has been classified and an owner has been assigned.', sortOrder: 20 },
      { title: 'Confidential and accessible reporting channels are available.', sortOrder: 25 },
      { title: 'The investigation, action, and closure timeline have been tracked.', sortOrder: 30 },
      { title: 'Unresolved or repeated issues have been escalated.', sortOrder: 40 },
      { title: 'Lessons learned have been captured.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G09',
    name: 'Training & Competency Governance',
    checklistType: 'global',
    category: 'HR',
    module: 'People & HR',
    description: 'Training matrix, completion tracking, overdue escalation',
    entityTargets: [],
    items: [
      { title: 'The mandatory role-based training matrix has been defined.', sortOrder: 10 },
      { title: 'Completion, expiry, and refreshers have been tracked.', sortOrder: 20 },
      { title: 'Assessment outcomes have been recorded where applicable.', sortOrder: 30 },
      { title: 'Overdue mandatory training has been escalated.', sortOrder: 40 },
      { title: 'Induction completion for new joiners has been validated.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G10',
    name: 'Business Continuity & Emergency Readiness',
    checklistType: 'global',
    category: 'BCP',
    module: 'BCP',
    description: 'BCP playbooks, contact tree, drill outcomes, incidents',
    entityTargets: [],
    items: [
      { title: 'The BCP and DR scenario playbooks have been maintained.', sortOrder: 10 },
      { title: 'Authority transfer protocols have been documented for each critical role.', sortOrder: 15 },
      { title: 'The owner and contact tree have been confirmed as current.', sortOrder: 20 },
      { title: 'The credential vault is accessible to authorised backup persons only.', sortOrder: 25 },
      { title: 'Test and drill completion and outcomes have been tracked.', sortOrder: 30 },
      { title: 'Incident response actions have been recorded.', sortOrder: 40 },
      { title: 'Plan updates have been reviewed after events.', sortOrder: 50 }
    ]
  }
];

// ─── Item-wise Checklists (I01–I40) ─────────────────────────────────────────

export const ITEM_WISE_CHECKLISTS = [
  // ── Finance (I01–I10) ──
  {
    v3Id: 'I01',
    name: 'Invoice Intake & Validation',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Expenses',
    description: 'Invoice completeness, supplier details, tax coding, duplicate check',
    entityTargets: ['expense', 'purchase'],
    items: [
      { title: 'The invoice exists and is readable.', sortOrder: 10 },
      { title: 'The supplier details are complete.', sortOrder: 20 },
      { title: 'The amount and tax coding have been validated.', sortOrder: 30 },
      { title: 'The duplicate invoice check has been completed.', sortOrder: 40 },
      { title: 'Evidence or an exception note has been attached.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'I02',
    name: 'Payment Approval & Release',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Expenses',
    description: 'Approval path, decision, payment method, proof, release',
    entityTargets: ['expense', 'purchase'],
    items: [
      { title: 'The correct approval path has been selected.', sortOrder: 10 },
      { title: 'The approver decision has been captured.', sortOrder: 20 },
      { title: 'The payment method and date have been verified.', sortOrder: 30 },
      { title: 'Payment proof has been attached.', sortOrder: 40 },
      { title: 'The final release confirmation has been recorded.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'I03',
    name: 'Cash Handling & Reconciliation',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Financial Controls',
    description: 'Dual-verify, variance, deposit trace, sign-off',
    entityTargets: ['financial_controls'],
    items: [
      { title: 'The cash count has been dual-verified.', sortOrder: 10 },
      { title: 'Any variance has been logged and investigated.', sortOrder: 20 },
      { title: 'The deposit trace has been recorded.', sortOrder: 30 },
      { title: 'The daily reconciliation has been signed off.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I04',
    name: 'Bank Card & Expense Card Controls',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Financial Controls',
    description: 'Cardholder, spend policy, receipt, monthly review',
    entityTargets: ['financial_controls'],
    items: [
      { title: 'The cardholder and limit have been validated.', sortOrder: 10 },
      { title: 'The eligible spend policy check has passed.', sortOrder: 20 },
      { title: 'The receipt or evidence has been attached.', sortOrder: 30 },
      { title: 'The monthly review has been completed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I05',
    name: 'Refund & Reversal Processing',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Refunds',
    description: 'Eligibility, approval, reversal trace, notification',
    entityTargets: ['refund', 'donor_refund'],
    items: [
      { title: 'Refund eligibility has been validated.', sortOrder: 10 },
      { title: 'The approval has been recorded.', sortOrder: 20 },
      { title: 'The transaction reversal trace has been retained.', sortOrder: 30 },
      { title: 'The stakeholder notification has been sent.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I06',
    name: 'Month-End Close',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Period Close',
    description: 'Reconciliations, journals, trial balance, variances, sign-off',
    entityTargets: [],
    periodType: 'month_end',
    items: [
      { title: 'The bank and ledger reconciliations have been completed.', sortOrder: 10 },
      { title: 'Accruals and journals have been posted.', sortOrder: 20 },
      { title: 'Depreciation entries have been calculated and posted.', sortOrder: 25 },
      { title: 'The payroll reconciliation to the general ledger has been completed.', sortOrder: 28 },
      { title: 'The trial balance has been reviewed.', sortOrder: 30 },
      { title: 'Variances have been explained.', sortOrder: 40 },
      { title: 'The close sign-off has been recorded.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'I07',
    name: 'Year-End & Annual Financial Close',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Period Close',
    description: 'Year-end adjustments, statements, audit support, board sign-off',
    entityTargets: [],
    periodType: 'year_end',
    items: [
      { title: 'The year-end adjustments have been completed.', sortOrder: 10 },
      { title: 'The financial statements pack has been prepared.', sortOrder: 20 },
      { title: 'The audit support documents are complete.', sortOrder: 30 },
      { title: 'The Board sign-off workflow has been completed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I08',
    name: 'BAS & Statutory Tax Lodgement',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'BAS',
    description: 'Period validation, tax checks, BAS review, lodgement evidence',
    entityTargets: ['bas_lodgement'],
    items: [
      { title: 'The data extraction period has been validated.', sortOrder: 10 },
      { title: 'The tax treatment checks have been completed.', sortOrder: 20 },
      { title: 'The BAS has been reviewed and approved.', sortOrder: 30 },
      { title: 'The lodgement evidence has been retained.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I09',
    name: 'Financial Record Keeping',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Records',
    description: 'Source docs, retention standards, access, retrieval test',
    entityTargets: ['financial_report'],
    items: [
      { title: 'Source documents have been indexed.', sortOrder: 10 },
      { title: 'Retention and naming standards have been met.', sortOrder: 20 },
      { title: 'Restricted access has been enforced.', sortOrder: 30 },
      { title: 'The retrieval test has been passed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I10',
    name: 'Emergency Financial Response',
    checklistType: 'item_wise',
    category: 'Finance',
    module: 'Finance',
    submodule: 'Emergency',
    description: 'Trigger, emergency approver, control actions, post-incident review',
    entityTargets: ['sweep_funds'],
    items: [
      { title: 'The trigger condition has been identified.', sortOrder: 10 },
      { title: 'The emergency approver path has been activated.', sortOrder: 20 },
      { title: 'Immediate control actions have been logged.', sortOrder: 30 },
      { title: 'The post-incident review has been completed.', sortOrder: 40 }
    ]
  },

  // ── Operations (I11–I18) ──
  {
    v3Id: 'I11',
    name: 'Funding Agreement Setup',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Funding Agreements',
    description: 'Agreement version, obligations, financial terms, monitoring owner',
    entityTargets: ['funding_agreement'],
    items: [
      { title: 'The agreement version has been approved.', sortOrder: 10 },
      { title: 'Obligations and milestones have been captured.', sortOrder: 20 },
      { title: 'The financial terms have been validated.', sortOrder: 30 },
      { title: 'The monitoring owner has been assigned.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I12',
    name: 'Project Registration & Setup',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Project Register',
    description: 'Objective, budget, milestones, risk/safeguarding checks',
    entityTargets: ['project_register', 'project'],
    items: [
      { title: 'The project objective and scope have been approved.', sortOrder: 10 },
      { title: 'The budget and owner have been assigned.', sortOrder: 20 },
      { title: 'Key milestones have been defined.', sortOrder: 30 },
      { title: 'Risk and safeguarding checks have been linked.', sortOrder: 40 },
      { title: 'Compliance with grant terms and donor conditions has been verified.', sortOrder: 45 }
    ]
  },
  {
    v3Id: 'I13',
    name: 'Project Delivery Monitoring',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Project Monitoring',
    description: 'Milestone progress, evidence, variance review, corrective actions',
    entityTargets: ['project_monitoring'],
    items: [
      { title: 'Milestone progress has been updated.', sortOrder: 10 },
      { title: 'Outcome evidence has been uploaded.', sortOrder: 20 },
      { title: 'The variance and dependency review has been completed.', sortOrder: 30 },
      { title: 'Corrective actions have been tracked.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I14',
    name: 'Project Change & Budget Exceedance',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Programs',
    description: 'Change request, threshold, impact analysis, decision log',
    entityTargets: ['project'],
    items: [
      { title: 'The change request has been documented.', sortOrder: 10 },
      { title: 'The threshold and approval rule have been applied.', sortOrder: 20 },
      { title: 'The impact analysis has been attached.', sortOrder: 30 },
      { title: 'The decision and communication have been logged.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I15',
    name: 'Field Partner Identification & Engagement',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Partner Vetting',
    description: 'Profile completeness, eligibility, risk flags, approval',
    entityTargets: ['partner_vetting', 'funding_partner'],
    items: [
      { title: 'Partner profile completeness has been verified.', sortOrder: 10 },
      { title: 'Alignment and eligibility have been screened.', sortOrder: 20 },
      { title: 'Initial risk flags have been captured.', sortOrder: 30 },
      { title: 'The engagement approval has been recorded.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I16',
    name: 'Due Diligence & Screening',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Partner Vetting',
    description: 'Identity, compliance/sanctions, financial & governance review',
    entityTargets: ['partner_vetting'],
    items: [
      { title: 'Identity and legal verification have been completed.', sortOrder: 10 },
      { title: 'Compliance and sanctions screening have been completed.', sortOrder: 20 },
      { title: 'The AML/CTF risk assessment has been performed.', sortOrder: 25 },
      { title: 'The financial and governance review has been completed.', sortOrder: 30 },
      { title: 'The decision rationale has been retained.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I17',
    name: 'Partner Registration & Review',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Grants & Donors',
    submodule: 'Partner Vetting',
    description: 'Registration details, review schedule, performance notes, renewal',
    entityTargets: ['partner', 'partner_vetting'],
    items: [
      { title: 'The registration details have been validated.', sortOrder: 10 },
      { title: 'The periodic review schedule has been set.', sortOrder: 20 },
      { title: 'Performance and compliance notes have been updated.', sortOrder: 30 },
      { title: 'The renewal and escalation path has been defined.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I18',
    name: 'Operational Record Keeping',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Operations',
    submodule: 'Records',
    description: 'Operational logs, evidence tagging, audit trace, retention',
    entityTargets: [],
    items: [
      { title: 'Operational logs are complete.', sortOrder: 10 },
      { title: 'Evidence has been tagged to workflow records.', sortOrder: 20 },
      { title: 'The audit trace is available.', sortOrder: 30 },
      { title: 'Retention controls have been verified.', sortOrder: 40 }
    ]
  },

  // ── HR & Volunteers (I19–I26) ──
  {
    v3Id: 'I19',
    name: 'Volunteer Recruitment & Onboarding',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'Volunteers',
    submodule: 'Volunteer Register',
    description: 'Role description, screening, induction, declarations',
    entityTargets: ['volunteer_person'],
    items: [
      { title: 'The role description has been approved.', sortOrder: 10 },
      { title: 'The application and screening have been completed.', sortOrder: 20 },
      { title: 'The induction has been completed.', sortOrder: 30 },
      { title: 'Required declarations have been acknowledged.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I20',
    name: 'Volunteer Training Completion',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'People & HR',
    submodule: 'Trainings',
    description: 'Module assignment, completion, competency check, refresher',
    entityTargets: ['hr_training'],
    items: [
      { title: 'Training modules have been assigned.', sortOrder: 10 },
      { title: 'Attendance and completion have been recorded.', sortOrder: 20 },
      { title: 'The competency check has been passed.', sortOrder: 30 },
      { title: 'The refresher date has been scheduled.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I21',
    name: 'Volunteer Register Management',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'Volunteers',
    submodule: 'Volunteer Register',
    description: 'Active/inactive status, contact details, role, exit records',
    entityTargets: ['volunteer_person'],
    items: [
      { title: 'The active or inactive status is current.', sortOrder: 10 },
      { title: 'Contact and emergency details are current.', sortOrder: 20 },
      { title: 'The role assignment is current.', sortOrder: 30 },
      { title: 'Exit records are complete.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I22',
    name: 'Safeguarding & Child Protection',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'People & HR',
    submodule: 'Employees',
    description: 'Mandatory checks, reporting channels, incident protocol, owner',
    entityTargets: ['hr_employee'],
    items: [
      { title: 'The National Police Check and Working with Children Check are current for relevant staff.', sortOrder: 5 },
      { title: 'Mandatory safeguarding checks have been completed.', sortOrder: 10 },
      { title: 'The code of conduct has been signed by all staff and volunteers.', sortOrder: 15 },
      { title: 'Reporting channels have been communicated.', sortOrder: 20 },
      { title: 'The incident protocol has been acknowledged.', sortOrder: 30 },
      { title: 'The safeguarding owner has been assigned.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I23',
    name: 'Health & Safety Compliance',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'People & HR',
    submodule: 'Employees',
    description: 'WHS induction, hazard reporting, site controls, corrective actions',
    entityTargets: ['hr_employee'],
    items: [
      { title: 'The WHS induction has been completed.', sortOrder: 10 },
      { title: 'Hazard and incident reporting is active.', sortOrder: 20 },
      { title: 'Site controls have been reviewed.', sortOrder: 30 },
      { title: 'Corrective actions have been tracked.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I24',
    name: 'Equal Employment Opportunity',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'People & HR',
    submodule: 'Employees',
    description: 'Recruitment fairness, conduct policy, complaint path, outcomes',
    entityTargets: ['hr_employee'],
    items: [
      { title: 'Recruitment fairness checks have been completed.', sortOrder: 10 },
      { title: 'The workplace conduct policy has been acknowledged.', sortOrder: 20 },
      { title: 'The complaint handling path has been communicated.', sortOrder: 30 },
      { title: 'Case outcomes have been recorded.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I25',
    name: 'Staff & Volunteer Conflict of Interest',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'People & HR',
    submodule: 'Employees',
    description: 'COI declaration, conflict assessment, mitigation, re-declaration',
    entityTargets: ['hr_employee'],
    items: [
      { title: 'The COI declaration has been submitted.', sortOrder: 10 },
      { title: 'The conflict assessment has been documented.', sortOrder: 20 },
      { title: 'Mitigation actions have been assigned.', sortOrder: 30 },
      { title: 'The re-declaration schedule has been set.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I26',
    name: 'Whistleblowing Case Management',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'Complaint',
    submodule: 'Complaint Register',
    description: 'Protected channel, confidentiality, investigation owner, closure',
    entityTargets: ['complaint'],
    items: [
      { title: 'A protected channel is available.', sortOrder: 10 },
      { title: 'An anonymous reporting mechanism is in place.', sortOrder: 15 },
      { title: 'Intake confidentiality has been preserved.', sortOrder: 20 },
      { title: 'Whistleblower retaliation protections have been communicated.', sortOrder: 25 },
      { title: 'The investigation owner and timeframe have been set.', sortOrder: 30 },
      { title: 'The outcome and closure have been recorded.', sortOrder: 40 }
    ]
  },

  // ── Marketing (I27–I32) ──
  {
    v3Id: 'I27',
    name: 'Marketing Campaign Compliance',
    checklistType: 'item_wise',
    category: 'Marketing',
    module: 'Marketing',
    submodule: 'Campaigns',
    description: 'Claims validation, legal review, approver sign-off, publish controls',
    entityTargets: ['social_media_campaign'],
    items: [
      { title: 'The campaign objective and claims have been validated.', sortOrder: 10 },
      { title: 'The legal and compliance review has been completed.', sortOrder: 20 },
      { title: 'The approval owner sign-off has been recorded.', sortOrder: 30 },
      { title: 'Publish controls have been confirmed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I28',
    name: 'Social Media Account Access & Security',
    checklistType: 'item_wise',
    category: 'Marketing',
    module: 'Marketing',
    submodule: 'Social Media',
    description: 'Account owner, access list, MFA, credential rotation',
    entityTargets: ['social_media_campaign'],
    items: [
      { title: 'The account owner and backup owner have been assigned.', sortOrder: 10 },
      { title: 'The access list and permissions have been reviewed.', sortOrder: 20 },
      { title: 'MFA and recovery methods have been verified.', sortOrder: 30 },
      { title: 'The credential rotation plan is current.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I29',
    name: 'Social Media Content Approval Workflow',
    checklistType: 'item_wise',
    category: 'Marketing',
    module: 'Marketing',
    submodule: 'Social Media',
    description: 'Draft review, approver decision, publish record, escalation path',
    entityTargets: ['social_media_campaign'],
    items: [
      { title: 'The draft has been reviewed against policy.', sortOrder: 10 },
      { title: 'The approver decision has been captured.', sortOrder: 20 },
      { title: 'The scheduled publish record has been retained.', sortOrder: 30 },
      { title: 'The incident and escalation path is ready.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I30',
    name: 'Weekly Marketing Reporting',
    checklistType: 'item_wise',
    category: 'Marketing',
    module: 'Marketing',
    submodule: 'Reports',
    description: 'KPI dataset, variance commentary, actions/owners, distribution',
    entityTargets: ['social_media_campaign'],
    items: [
      { title: 'The KPI dataset is complete.', sortOrder: 10 },
      { title: 'Variance commentary has been added.', sortOrder: 20 },
      { title: 'Actions and owners have been assigned.', sortOrder: 30 },
      { title: 'Report distribution has been completed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I31',
    name: 'Marketing Training & Resources',
    checklistType: 'item_wise',
    category: 'Marketing',
    module: 'Marketing',
    submodule: 'Training',
    description: 'Materials currency, completion tracking, repository, improvements',
    entityTargets: ['social_media_campaign'],
    items: [
      { title: 'Training materials are current.', sortOrder: 10 },
      { title: 'Completion tracking is up to date.', sortOrder: 20 },
      { title: 'The resource repository has been indexed.', sortOrder: 30 },
      { title: 'Improvement actions have been logged.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I32',
    name: 'Website & Digital Policy Compliance',
    checklistType: 'item_wise',
    category: 'Marketing',
    module: 'Marketing',
    submodule: 'Web',
    description: 'Legal pages, privacy/cookie settings, accessibility, change log',
    entityTargets: ['social_media_campaign'],
    items: [
      { title: 'The required legal pages are current.', sortOrder: 10 },
      { title: 'Privacy and cookie settings have been validated.', sortOrder: 20 },
      { title: 'Accessibility baseline checks have been completed.', sortOrder: 30 },
      { title: 'The change log has been maintained.', sortOrder: 40 }
    ]
  },

  // ── Donors (I33–I36) ──
  {
    v3Id: 'I33',
    name: 'Donor Care Operations',
    checklistType: 'item_wise',
    category: 'Donors',
    module: 'Grants & Donors',
    submodule: 'Donor Register',
    description: 'Interaction standards, consent, issue pathway, escalation',
    entityTargets: ['donor'],
    items: [
      { title: 'Donor interaction standards have been met.', sortOrder: 10 },
      { title: 'Consent and preferences have been captured.', sortOrder: 20 },
      { title: 'Donor receipts and acknowledgements have been issued promptly.', sortOrder: 25 },
      { title: 'The issue and refund pathway has been defined.', sortOrder: 30 },
      { title: 'High-priority case escalation has been set.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I34',
    name: 'VIP Donor Handling',
    checklistType: 'item_wise',
    category: 'Donors',
    module: 'Grants & Donors',
    submodule: 'Donor Register',
    description: 'Sensitive handling, approval requirements, communication log, risk checks',
    entityTargets: ['donor'],
    items: [
      { title: 'The sensitive handling protocol has been applied.', sortOrder: 10 },
      { title: 'Additional approval requirements have been met.', sortOrder: 20 },
      { title: 'The communication log is complete.', sortOrder: 30 },
      { title: 'Risk and privacy checks have been completed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I35',
    name: 'Community Sponsorship Management',
    checklistType: 'item_wise',
    category: 'Donors',
    module: 'Grants & Donors',
    submodule: 'Programs',
    description: 'Eligibility, agreement, monitoring cadence, closure outcomes',
    entityTargets: ['project'],
    items: [
      { title: 'Sponsorship eligibility has been validated.', sortOrder: 10 },
      { title: 'The agreement and deliverables have been recorded.', sortOrder: 20 },
      { title: 'The monitoring and reporting cadence has been set.', sortOrder: 30 },
      { title: 'Closure outcomes have been documented.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I36',
    name: 'Donation Box Operations & Reporting',
    checklistType: 'item_wise',
    category: 'Donors',
    module: 'Finance',
    submodule: 'Donation Boxes',
    description: 'Register, collection controls, variances, weekly stats',
    entityTargets: ['donation_box'],
    items: [
      { title: 'The box register and custody trace are complete.', sortOrder: 10 },
      { title: 'Collection and count controls have been enforced.', sortOrder: 20 },
      { title: 'Variances have been documented.', sortOrder: 30 },
      { title: 'Weekly stats have been reported.', sortOrder: 40 }
    ]
  },

  // ── IT & Legal (I37–I40) ──
  {
    v3Id: 'I37',
    name: 'Access Control & Credential Management',
    checklistType: 'item_wise',
    category: 'IT & Legal',
    module: 'Charity Administration',
    submodule: 'Registrations & Licenses',
    description: 'Joiner/mover/leaver tasks, privileged access, MFA, access review',
    entityTargets: ['registration_license'],
    items: [
      { title: 'Joiner, mover, and leaver access tasks have been completed.', sortOrder: 10 },
      { title: 'Privileged access approvals have been recorded.', sortOrder: 20 },
      { title: 'Password and MFA standards have been enforced.', sortOrder: 30 },
      { title: 'The access review cycle has been completed.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I38',
    name: 'Backup & Recovery Operations',
    checklistType: 'item_wise',
    category: 'IT & Legal',
    module: 'Charity Administration',
    submodule: 'Registrations & Licenses',
    description: 'Backup schedule, restore test, coverage, exception backlog',
    entityTargets: ['registration_license'],
    items: [
      { title: 'The backup schedule has been executed.', sortOrder: 10 },
      { title: 'Restore test evidence has been retained.', sortOrder: 20 },
      { title: 'Critical system coverage has been confirmed.', sortOrder: 30 },
      { title: 'The exception backlog has been tracked.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I39',
    name: 'Legal, Permits & Insurance Compliance',
    checklistType: 'item_wise',
    category: 'IT & Legal',
    module: 'Charity Administration',
    submodule: 'Registrations & Licenses',
    description: 'Permits/licences active, insurance current, renewals, escalation',
    entityTargets: ['registration_license', 'licence_document', 'permit_document'],
    items: [
      { title: 'The required permits and licences are active.', sortOrder: 10 },
      { title: 'Insurance policies (public liability, D&O, volunteer, cyber) are current.', sortOrder: 20 },
      { title: 'The sum insured has been reviewed against the activity scale annually.', sortOrder: 25 },
      { title: 'Renewal deadlines have been tracked.', sortOrder: 30 },
      { title: 'A Certificate of Currency has been stored for each policy.', sortOrder: 35 },
      { title: 'Legal exceptions have been escalated.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I40',
    name: 'Succession & Key Person Continuity',
    checklistType: 'item_wise',
    category: 'IT & Legal',
    module: 'Charity Administration',
    submodule: 'Governing Doc',
    description: 'Critical role owners, delegates, handover docs, contingency triggers',
    entityTargets: ['governing_document'],
    items: [
      { title: 'Critical role owners have been identified.', sortOrder: 10 },
      { title: 'Delegates and handover documents have been maintained.', sortOrder: 20 },
      { title: 'The knowledge transfer status has been reviewed.', sortOrder: 30 },
      { title: 'Contingency triggers have been documented.', sortOrder: 40 }
    ]
  },

  // ── Gap-fill: entity types that had no item-wise checklist (I41–I47) ──
  {
    v3Id: 'I41',
    name: 'Risk Workflow Compliance',
    checklistType: 'item_wise',
    category: 'Risk',
    module: 'Risk',
    submodule: 'Risk Management',
    description: 'Risk owner, treatment plan, attachments, review date, responsible person checks',
    entityTargets: ['risk'],
    items: [
      { title: 'The Risk owner or responsible person has been assigned.', sortOrder: 10 },
      { title: 'The responsible person suitability check is current.', sortOrder: 15 },
      { title: 'The risk category, likelihood, and impact have been documented.', sortOrder: 20 },
      { title: 'A supporting attachment or evidence has been uploaded.', sortOrder: 30 },
      { title: 'The treatment plan has been captured with owner and due date.', sortOrder: 40 },
      { title: 'Controls and assumptions have been documented for auditability.', sortOrder: 50 },
      { title: 'The next review date has been set.', sortOrder: 60 },
      { title: 'The escalation path and triggers have been confirmed.', sortOrder: 70 }
    ]
  },
  {
    v3Id: 'I42',
    name: 'Policy Approval & Compliance',
    checklistType: 'item_wise',
    category: 'Governance',
    module: 'Policies',
    description: 'Policy approval, review cycle, acknowledgement, version control',
    entityTargets: ['policy'],
    items: [
      { title: 'The policy has been approved by the Board or designated authority.', sortOrder: 10 },
      { title: 'The effective date and next review date have been set.', sortOrder: 20 },
      { title: 'The policy has been distributed to all relevant staff and volunteers.', sortOrder: 30 },
      { title: 'Acknowledgement completion has been tracked per user.', sortOrder: 40 },
      { title: 'The superseded version has been archived with version history.', sortOrder: 50 },
      { title: 'Amendments have been routed through the approvals module before publish.', sortOrder: 60 }
    ]
  },
  {
    v3Id: 'I43',
    name: 'Fiscal Report Compliance',
    checklistType: 'item_wise',
    category: 'Reporting',
    module: 'Reporting',
    submodule: 'Fiscal Reports',
    description: 'Fiscal period validation, statutory compliance, lodgement, evidence',
    entityTargets: ['fiscal_report'],
    items: [
      { title: 'The fiscal period data has been extracted and validated.', sortOrder: 10 },
      { title: 'The report has been prepared in accordance with Australian Accounting Standards.', sortOrder: 20 },
      { title: 'The report has been reviewed and approved by the Finance Manager.', sortOrder: 30 },
      { title: 'The lodgement and submission evidence has been retained.', sortOrder: 40 },
      { title: 'Variances from the prior period have been explained.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'I44',
    name: 'Disciplinary Record Management',
    checklistType: 'item_wise',
    category: 'HR & Volunteers',
    module: 'People & HR',
    submodule: 'Disciplinary Records',
    description: 'Incident documentation, investigation, outcome, appeal rights',
    entityTargets: ['disciplinary_record'],
    items: [
      { title: 'The incident has been documented with date, parties, and description.', sortOrder: 10 },
      { title: 'The investigation has been conducted and findings recorded.', sortOrder: 20 },
      { title: 'The employee or volunteer has been given the opportunity to respond.', sortOrder: 30 },
      { title: 'The outcome and any sanctions have been recorded.', sortOrder: 40 },
      { title: 'Appeal rights have been communicated.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'I45',
    name: 'Responsible Person Suitability',
    checklistType: 'item_wise',
    category: 'Governance',
    module: 'Charity Administration',
    submodule: 'Responsible People',
    description: 'Suitability checks, disqualification screening, declarations, renewal',
    entityTargets: ['responsible_person'],
    items: [
      { title: 'The person is not disqualified from managing a corporation under the Corporations Act 2001.', sortOrder: 10 },
      { title: 'The National Police Check and Working with Children Check are current.', sortOrder: 20 },
      { title: 'The ACNC disqualification check has been performed.', sortOrder: 30 },
      { title: 'Conflicts of interest have been disclosed.', sortOrder: 40 },
      { title: 'The commitment to act in the best interests of the charity has been confirmed.', sortOrder: 50 },
      { title: 'The suitability renewal reminder is active.', sortOrder: 60 }
    ]
  },
  {
    v3Id: 'I46',
    name: 'Approval Threshold Review',
    checklistType: 'item_wise',
    category: 'Governance',
    module: 'Charity Administration',
    submodule: 'Approval Thresholds',
    description: 'Threshold levels, signatory matrix, periodic review, exceptions',
    entityTargets: ['approval_thresholds'],
    items: [
      { title: 'Approval threshold levels have been documented and are current.', sortOrder: 10 },
      { title: 'The signatory matrix matches current role holders.', sortOrder: 20 },
      { title: 'Thresholds have been reviewed at least annually.', sortOrder: 30 },
      { title: 'Exceptions to thresholds have been documented and approved.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I47',
    name: 'Yearly Statements Preparation',
    checklistType: 'item_wise',
    category: 'Compliance',
    module: 'Charity Administration',
    submodule: 'Yearly Statements',
    description: 'AIS preparation, ACNC submission, board sign-off, evidence retention',
    entityTargets: ['yearly_statements'],
    items: [
      { title: 'The Annual Information Statement inputs are complete.', sortOrder: 10 },
      { title: 'The financial statements have been reviewed and signed by the Board.', sortOrder: 20 },
      { title: 'The ACNC submission has been lodged within the statutory deadline.', sortOrder: 30 },
      { title: 'The submission confirmation and evidence pack have been retained.', sortOrder: 40 },
      { title: 'The responsible persons register has been updated for the period.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'I48',
    name: 'Inquiry Register Record Review',
    checklistType: 'item_wise',
    category: 'Governance',
    module: 'Governance',
    submodule: 'Inquiries',
    description: 'Generic review checklist for user-defined inquiry register records and their approval workflow',
    entityTargets: ['inquiry_record'],
    items: [
      { title: 'The record has been completed against its inquiry template fields.', sortOrder: 10 },
      { title: 'The record has been linked to the correct parent entity or register.', sortOrder: 20 },
      { title: 'Supporting documents and evidence have been attached.', sortOrder: 30 },
      { title: 'The approval workflow steps and signatories are configured correctly.', sortOrder: 40 },
      { title: 'Each required approver has recorded their decision.', sortOrder: 50 },
      { title: 'The outcome, status, and audit trail have been captured.', sortOrder: 60 }
    ]
  },
  {
    v3Id: 'I49',
    name: 'Supplier Vetting & Due Diligence',
    checklistType: 'item_wise',
    category: 'Operations',
    module: 'Operations',
    submodule: 'Suppliers',
    description: 'Supplier onboarding vetting — identity, screening, compliance, contract terms and approval',
    entityTargets: ['supplier'],
    items: [
      { title: 'Supplier details and contact information are complete and verified.', sortOrder: 10 },
      { title: 'The supplier’s legal registration / ABN has been validated.', sortOrder: 20 },
      { title: 'Conflict of interest and related-party checks have been completed.', sortOrder: 30 },
      { title: 'Sanctions and compliance screening have been completed.', sortOrder: 40 },
      { title: 'Required certifications, insurances and licenses have been verified.', sortOrder: 50 },
      { title: 'Pricing, contract terms and approval thresholds have been reviewed.', sortOrder: 60 },
      { title: 'The vetting decision and supporting evidence have been recorded.', sortOrder: 70 }
    ]
  }
];

// ─── Combined + stats ────────────────────────────────────────────────────────

export const CHECKLIST_LIBRARY_V3 = [...GLOBAL_CHECKLISTS, ...ITEM_WISE_CHECKLISTS];

export const V3_LIBRARY_STATS = {
  version: '3.1',
  sourceFile: 'checklists_v3_clean.xlsx + checklists_v2.xlsx enrichment',
  total: 59,
  global: 10,
  itemWise: 49,
  categories: {
    Governance: 3,
    Compliance: 1,
    Audit: 1,
    Risk: 1,
    Finance: 10,
    'IT/Security': 1,
    Complaints: 1,
    HR: 1,
    BCP: 1,
    Operations: 9,
    'HR & Volunteers': 8,
    Marketing: 6,
    Donors: 4,
    'IT & Legal': 4
  }
};
