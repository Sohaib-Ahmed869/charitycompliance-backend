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
      { title: 'Maintain current board and responsible person register.', sortOrder: 10 },
      { title: 'Validate fit-and-proper checks (police/WWCC where required).', sortOrder: 20 },
      { title: 'ACNC disqualification check performed on appointment and at annual review.', sortOrder: 25 },
      { title: 'Record conflicts of interest declarations.', sortOrder: 30 },
      { title: 'Board member declarations (COI, fit-and-proper) signed annually.', sortOrder: 35 },
      { title: 'Confirm governance roles and delegations are current.', sortOrder: 40 },
      { title: 'Track and approve governance changes.', sortOrder: 50 }
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
      { title: 'Confirm policy owner and version metadata.', sortOrder: 10 },
      { title: 'Validate review/approval date and authority.', sortOrder: 20 },
      { title: 'Ensure policy distribution and acknowledgement workflow.', sortOrder: 30 },
      { title: 'Staff and volunteers have acknowledged they read and understood the policy.', sortOrder: 35 },
      { title: 'Archive superseded versions with traceability.', sortOrder: 40 },
      { title: 'Record exceptions and remediation actions.', sortOrder: 50 }
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
      { title: 'Confirm registrations/licences/permits are active.', sortOrder: 10 },
      { title: 'Complete annual information statement inputs.', sortOrder: 20 },
      { title: 'Validate statutory reporting deadlines.', sortOrder: 30 },
      { title: 'Retain evidence pack for regulator submissions.', sortOrder: 40 },
      { title: 'Log late items and corrective actions.', sortOrder: 50 }
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
      { title: 'Define annual internal audit plan.', sortOrder: 10 },
      { title: 'Track external audit readiness evidence.', sortOrder: 20 },
      { title: 'Log findings by severity and owner.', sortOrder: 30 },
      { title: 'Monitor remediation closure status.', sortOrder: 40 },
      { title: 'Produce quarterly assurance summary.', sortOrder: 50 }
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
      { title: 'Ensure risk owner and category are assigned.', sortOrder: 10 },
      { title: 'Responsible person confirmed and suitability check current.', sortOrder: 15 },
      { title: 'Risk appetite statement approved by the Board.', sortOrder: 18 },
      { title: 'Validate treatment plan and due dates.', sortOrder: 20 },
      { title: 'Record residual risk review outcomes.', sortOrder: 30 },
      { title: 'High and extreme risks reviewed by the Board at each meeting.', sortOrder: 35 },
      { title: 'Escalate overdue critical treatments.', sortOrder: 40 },
      { title: 'Emerging risks from incidents/complaints triaged into register within 14 days.', sortOrder: 45 },
      { title: 'Confirm next review date.', sortOrder: 50 }
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
      { title: 'Validate approval thresholds and signatories.', sortOrder: 10 },
      { title: 'Confirm segregation of duties for payment flow.', sortOrder: 20 },
      { title: 'Verify exception approvals are documented.', sortOrder: 30 },
      { title: 'Check reconciliation and close controls.', sortOrder: 40 },
      { title: 'Anti-fraud controls in place (dual sign-off, transaction monitoring).', sortOrder: 45 },
      { title: 'Track periodic control testing.', sortOrder: 50 }
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
      { title: 'Validate user access by role and least privilege.', sortOrder: 10 },
      { title: 'Confirm MFA/credential policy compliance.', sortOrder: 20 },
      { title: 'Record privileged access changes.', sortOrder: 30 },
      { title: 'Data encryption in place for sensitive information at rest and in transit.', sortOrder: 35 },
      { title: 'Confirm backup and retention controls.', sortOrder: 40 },
      { title: 'Track security incidents and follow-up.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G08',
    name: 'Complaints, Whistleblowing & Non-Conformance',
    checklistType: 'global',
    category: 'Complaints',
    module: 'Complaints',
    description: 'Register, severity, investigation, lessons learned',
    entityTargets: [],
    items: [
      { title: 'Register complaint/non-conformance entry completeness.', sortOrder: 10 },
      { title: 'Classify severity and assign owner.', sortOrder: 20 },
      { title: 'Confidential and accessible reporting channels available.', sortOrder: 25 },
      { title: 'Track investigation, action, and closure timeline.', sortOrder: 30 },
      { title: 'Escalate unresolved or repeated issues.', sortOrder: 40 },
      { title: 'Capture lessons learned.', sortOrder: 50 }
    ]
  },
  {
    v3Id: 'G09',
    name: 'Training & Competency Governance',
    checklistType: 'global',
    category: 'HR',
    module: 'HR',
    description: 'Training matrix, completion tracking, overdue escalation',
    entityTargets: [],
    items: [
      { title: 'Define mandatory role-based training matrix.', sortOrder: 10 },
      { title: 'Track completion, expiry, and refreshers.', sortOrder: 20 },
      { title: 'Record assessment outcomes where applicable.', sortOrder: 30 },
      { title: 'Escalate overdue mandatory training.', sortOrder: 40 },
      { title: 'Validate induction completion for new joiners.', sortOrder: 50 }
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
      { title: 'Maintain BCP/DR scenario playbooks.', sortOrder: 10 },
      { title: 'Authority transfer protocols documented for each critical role.', sortOrder: 15 },
      { title: 'Confirm owner and contact tree currency.', sortOrder: 20 },
      { title: 'Credential vault accessible to authorised backup persons only.', sortOrder: 25 },
      { title: 'Track test/drill completion and outcomes.', sortOrder: 30 },
      { title: 'Record incident response actions.', sortOrder: 40 },
      { title: 'Review plan updates after events.', sortOrder: 50 }
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
      { title: 'Invoice exists and is readable.', sortOrder: 10 },
      { title: 'Supplier details complete.', sortOrder: 20 },
      { title: 'Amount/tax coding validated.', sortOrder: 30 },
      { title: 'Duplicate invoice check complete.', sortOrder: 40 },
      { title: 'Attach evidence or exception note.', sortOrder: 50 }
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
      { title: 'Correct approval path selected.', sortOrder: 10 },
      { title: 'Approver decision captured.', sortOrder: 20 },
      { title: 'Payment method and date verified.', sortOrder: 30 },
      { title: 'Payment proof attached.', sortOrder: 40 },
      { title: 'Final release confirmation recorded.', sortOrder: 50 }
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
      { title: 'Cash count dual-verified.', sortOrder: 10 },
      { title: 'Variance logged and investigated.', sortOrder: 20 },
      { title: 'Deposit trace recorded.', sortOrder: 30 },
      { title: 'Daily reconciliation signed off.', sortOrder: 40 }
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
      { title: 'Cardholder and limit validated.', sortOrder: 10 },
      { title: 'Eligible spend policy check passed.', sortOrder: 20 },
      { title: 'Receipt/evidence attached.', sortOrder: 30 },
      { title: 'Monthly review completed.', sortOrder: 40 }
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
      { title: 'Refund eligibility validated.', sortOrder: 10 },
      { title: 'Approval recorded.', sortOrder: 20 },
      { title: 'Transaction reversal trace retained.', sortOrder: 30 },
      { title: 'Stakeholder notification sent.', sortOrder: 40 }
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
      { title: 'Bank and ledger reconciliations complete.', sortOrder: 10 },
      { title: 'Accruals/journals posted.', sortOrder: 20 },
      { title: 'Depreciation entries calculated and posted.', sortOrder: 25 },
      { title: 'Payroll reconciliation to general ledger completed.', sortOrder: 28 },
      { title: 'Trial balance reviewed.', sortOrder: 30 },
      { title: 'Variances explained.', sortOrder: 40 },
      { title: 'Close sign-off recorded.', sortOrder: 50 }
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
      { title: 'Year-end adjustments completed.', sortOrder: 10 },
      { title: 'Financial statements pack prepared.', sortOrder: 20 },
      { title: 'Audit support docs complete.', sortOrder: 30 },
      { title: 'Board sign-off workflow completed.', sortOrder: 40 }
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
      { title: 'Data extraction period validated.', sortOrder: 10 },
      { title: 'Tax treatment checks complete.', sortOrder: 20 },
      { title: 'BAS reviewed and approved.', sortOrder: 30 },
      { title: 'Lodgement evidence retained.', sortOrder: 40 }
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
      { title: 'Source documents indexed.', sortOrder: 10 },
      { title: 'Retention and naming standards met.', sortOrder: 20 },
      { title: 'Restricted access enforced.', sortOrder: 30 },
      { title: 'Retrieval test passed.', sortOrder: 40 }
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
      { title: 'Trigger condition identified.', sortOrder: 10 },
      { title: 'Emergency approver path activated.', sortOrder: 20 },
      { title: 'Immediate control actions logged.', sortOrder: 30 },
      { title: 'Post-incident review completed.', sortOrder: 40 }
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
      { title: 'Agreement version approved.', sortOrder: 10 },
      { title: 'Obligations and milestones captured.', sortOrder: 20 },
      { title: 'Financial terms validated.', sortOrder: 30 },
      { title: 'Monitoring owner assigned.', sortOrder: 40 }
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
      { title: 'Project objective and scope approved.', sortOrder: 10 },
      { title: 'Budget and owner assigned.', sortOrder: 20 },
      { title: 'Key milestones defined.', sortOrder: 30 },
      { title: 'Risk and safeguarding checks linked.', sortOrder: 40 },
      { title: 'Compliance with grant terms and donor conditions verified.', sortOrder: 45 }
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
      { title: 'Milestone progress updated.', sortOrder: 10 },
      { title: 'Outcome evidence uploaded.', sortOrder: 20 },
      { title: 'Variance and dependency review completed.', sortOrder: 30 },
      { title: 'Corrective actions tracked.', sortOrder: 40 }
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
      { title: 'Change request documented.', sortOrder: 10 },
      { title: 'Threshold/approval rule applied.', sortOrder: 20 },
      { title: 'Impact analysis attached.', sortOrder: 30 },
      { title: 'Decision and communication logged.', sortOrder: 40 }
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
      { title: 'Partner profile completeness verified.', sortOrder: 10 },
      { title: 'Alignment and eligibility screened.', sortOrder: 20 },
      { title: 'Initial risk flags captured.', sortOrder: 30 },
      { title: 'Engagement approval recorded.', sortOrder: 40 }
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
      { title: 'Identity/legal verification complete.', sortOrder: 10 },
      { title: 'Compliance and sanctions screening complete.', sortOrder: 20 },
      { title: 'AML/CTF risk assessment performed.', sortOrder: 25 },
      { title: 'Financial and governance review complete.', sortOrder: 30 },
      { title: 'Decision rationale retained.', sortOrder: 40 }
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
      { title: 'Registration details validated.', sortOrder: 10 },
      { title: 'Periodic review schedule set.', sortOrder: 20 },
      { title: 'Performance and compliance notes updated.', sortOrder: 30 },
      { title: 'Renewal/escalation path defined.', sortOrder: 40 }
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
      { title: 'Operational logs complete.', sortOrder: 10 },
      { title: 'Evidence tagged to workflow records.', sortOrder: 20 },
      { title: 'Audit trace available.', sortOrder: 30 },
      { title: 'Retention controls verified.', sortOrder: 40 }
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
      { title: 'Role description approved.', sortOrder: 10 },
      { title: 'Application and screening completed.', sortOrder: 20 },
      { title: 'Induction completed.', sortOrder: 30 },
      { title: 'Required declarations acknowledged.', sortOrder: 40 }
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
      { title: 'Training modules assigned.', sortOrder: 10 },
      { title: 'Attendance/completion recorded.', sortOrder: 20 },
      { title: 'Competency check passed.', sortOrder: 30 },
      { title: 'Refresher date scheduled.', sortOrder: 40 }
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
      { title: 'Active/inactive status current.', sortOrder: 10 },
      { title: 'Contact and emergency details current.', sortOrder: 20 },
      { title: 'Role assignment current.', sortOrder: 30 },
      { title: 'Exit records complete.', sortOrder: 40 }
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
      { title: 'National Police Check and Working with Children Check current for relevant staff.', sortOrder: 5 },
      { title: 'Mandatory safeguarding checks complete.', sortOrder: 10 },
      { title: 'Code of conduct signed by all staff and volunteers.', sortOrder: 15 },
      { title: 'Reporting channels communicated.', sortOrder: 20 },
      { title: 'Incident protocol acknowledged.', sortOrder: 30 },
      { title: 'Safeguarding owner assigned.', sortOrder: 40 }
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
      { title: 'WHS induction completed.', sortOrder: 10 },
      { title: 'Hazard/incident reporting active.', sortOrder: 20 },
      { title: 'Site controls reviewed.', sortOrder: 30 },
      { title: 'Corrective actions tracked.', sortOrder: 40 }
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
      { title: 'Recruitment fairness checks complete.', sortOrder: 10 },
      { title: 'Workplace conduct policy acknowledged.', sortOrder: 20 },
      { title: 'Complaint handling path communicated.', sortOrder: 30 },
      { title: 'Case outcomes recorded.', sortOrder: 40 }
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
      { title: 'COI declaration submitted.', sortOrder: 10 },
      { title: 'Conflict assessment documented.', sortOrder: 20 },
      { title: 'Mitigation actions assigned.', sortOrder: 30 },
      { title: 'Re-declaration schedule set.', sortOrder: 40 }
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
      { title: 'Protected channel available.', sortOrder: 10 },
      { title: 'Anonymous reporting mechanism in place.', sortOrder: 15 },
      { title: 'Intake confidentiality preserved.', sortOrder: 20 },
      { title: 'Whistleblower retaliation protections communicated.', sortOrder: 25 },
      { title: 'Investigation owner/timeframe set.', sortOrder: 30 },
      { title: 'Outcome and closure recorded.', sortOrder: 40 }
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
      { title: 'Campaign objective and claims validated.', sortOrder: 10 },
      { title: 'Legal/compliance review complete.', sortOrder: 20 },
      { title: 'Approval owner sign-off recorded.', sortOrder: 30 },
      { title: 'Publish controls confirmed.', sortOrder: 40 }
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
      { title: 'Account owner and backup owner assigned.', sortOrder: 10 },
      { title: 'Access list and permissions reviewed.', sortOrder: 20 },
      { title: 'MFA and recovery methods verified.', sortOrder: 30 },
      { title: 'Credential rotation plan current.', sortOrder: 40 }
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
      { title: 'Draft reviewed against policy.', sortOrder: 10 },
      { title: 'Approver decision captured.', sortOrder: 20 },
      { title: 'Scheduled publish record retained.', sortOrder: 30 },
      { title: 'Incident/escalation path ready.', sortOrder: 40 }
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
      { title: 'KPI dataset complete.', sortOrder: 10 },
      { title: 'Variance commentary added.', sortOrder: 20 },
      { title: 'Actions/owners assigned.', sortOrder: 30 },
      { title: 'Report distribution completed.', sortOrder: 40 }
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
      { title: 'Training materials current.', sortOrder: 10 },
      { title: 'Completion tracking up to date.', sortOrder: 20 },
      { title: 'Resource repository indexed.', sortOrder: 30 },
      { title: 'Improvement actions logged.', sortOrder: 40 }
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
      { title: 'Required legal pages current.', sortOrder: 10 },
      { title: 'Privacy/cookie settings validated.', sortOrder: 20 },
      { title: 'Accessibility baseline checks completed.', sortOrder: 30 },
      { title: 'Change log maintained.', sortOrder: 40 }
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
      { title: 'Donor interaction standards met.', sortOrder: 10 },
      { title: 'Consent/preferences captured.', sortOrder: 20 },
      { title: 'Donor receipts and acknowledgements issued promptly.', sortOrder: 25 },
      { title: 'Issue/refund pathway defined.', sortOrder: 30 },
      { title: 'High-priority case escalation set.', sortOrder: 40 }
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
      { title: 'Sensitive handling protocol applied.', sortOrder: 10 },
      { title: 'Additional approval requirements met.', sortOrder: 20 },
      { title: 'Communication log complete.', sortOrder: 30 },
      { title: 'Risk/privacy checks complete.', sortOrder: 40 }
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
      { title: 'Sponsorship eligibility validated.', sortOrder: 10 },
      { title: 'Agreement and deliverables recorded.', sortOrder: 20 },
      { title: 'Monitoring and reporting cadence set.', sortOrder: 30 },
      { title: 'Closure outcomes documented.', sortOrder: 40 }
    ]
  },
  {
    v3Id: 'I36',
    name: 'Donation Box Operations & Reporting',
    checklistType: 'item_wise',
    category: 'Donors',
    module: 'Finances',
    submodule: 'Donation Boxes',
    description: 'Register, collection controls, variances, weekly stats',
    entityTargets: ['donation_box'],
    items: [
      { title: 'Box register and custody trace complete.', sortOrder: 10 },
      { title: 'Collection and count controls enforced.', sortOrder: 20 },
      { title: 'Variances documented.', sortOrder: 30 },
      { title: 'Weekly stats reported.', sortOrder: 40 }
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
      { title: 'Joiner/mover/leaver access tasks completed.', sortOrder: 10 },
      { title: 'Privileged access approvals recorded.', sortOrder: 20 },
      { title: 'Password/MFA standards enforced.', sortOrder: 30 },
      { title: 'Access review cycle completed.', sortOrder: 40 }
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
      { title: 'Backup schedule executed.', sortOrder: 10 },
      { title: 'Restore test evidence retained.', sortOrder: 20 },
      { title: 'Critical system coverage confirmed.', sortOrder: 30 },
      { title: 'Exception backlog tracked.', sortOrder: 40 }
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
      { title: 'Required permits/licences active.', sortOrder: 10 },
      { title: 'Insurance policies current (public liability, D&O, volunteer, cyber).', sortOrder: 20 },
      { title: 'Sum insured reviewed against activity scale annually.', sortOrder: 25 },
      { title: 'Renewal deadlines tracked.', sortOrder: 30 },
      { title: 'Certificate of Currency stored for each policy.', sortOrder: 35 },
      { title: 'Legal exceptions escalated.', sortOrder: 40 }
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
      { title: 'Critical role owners identified.', sortOrder: 10 },
      { title: 'Delegates and handover docs maintained.', sortOrder: 20 },
      { title: 'Knowledge transfer status reviewed.', sortOrder: 30 },
      { title: 'Contingency triggers documented.', sortOrder: 40 }
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
      { title: 'Risk owner or responsible person assigned.', sortOrder: 10 },
      { title: 'Responsible person suitability check is current.', sortOrder: 15 },
      { title: 'Risk category, likelihood, and impact documented.', sortOrder: 20 },
      { title: 'Supporting attachment or evidence uploaded.', sortOrder: 30 },
      { title: 'Treatment plan captured with owner and due date.', sortOrder: 40 },
      { title: 'Controls and assumptions documented for auditability.', sortOrder: 50 },
      { title: 'Next review date set.', sortOrder: 60 },
      { title: 'Escalation path and triggers confirmed.', sortOrder: 70 }
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
      { title: 'Policy approved by the Board or designated authority.', sortOrder: 10 },
      { title: 'Effective date and next review date set.', sortOrder: 20 },
      { title: 'Policy distributed to all relevant staff and volunteers.', sortOrder: 30 },
      { title: 'Acknowledgement completion tracked per user.', sortOrder: 40 },
      { title: 'Superseded version archived with version history.', sortOrder: 50 },
      { title: 'Amendments go through approvals module before publish.', sortOrder: 60 }
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
      { title: 'Fiscal period data extracted and validated.', sortOrder: 10 },
      { title: 'Report prepared in accordance with Australian Accounting Standards.', sortOrder: 20 },
      { title: 'Report reviewed and approved by Finance Manager.', sortOrder: 30 },
      { title: 'Lodgement/submission evidence retained.', sortOrder: 40 },
      { title: 'Variances from prior period explained.', sortOrder: 50 }
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
      { title: 'Incident documented with date, parties, and description.', sortOrder: 10 },
      { title: 'Investigation conducted and findings recorded.', sortOrder: 20 },
      { title: 'Employee/volunteer given opportunity to respond.', sortOrder: 30 },
      { title: 'Outcome and any sanctions recorded.', sortOrder: 40 },
      { title: 'Appeal rights communicated.', sortOrder: 50 }
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
      { title: 'Not disqualified from managing a corporation under Corporations Act 2001.', sortOrder: 10 },
      { title: 'National Police Check and Working with Children Check current.', sortOrder: 20 },
      { title: 'ACNC disqualification check performed.', sortOrder: 30 },
      { title: 'Conflicts of interest disclosed.', sortOrder: 40 },
      { title: 'Commitment to act in best interests of the charity confirmed.', sortOrder: 50 },
      { title: 'Suitability renewal reminder active.', sortOrder: 60 }
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
      { title: 'Approval threshold levels documented and current.', sortOrder: 10 },
      { title: 'Signatory matrix matches current role holders.', sortOrder: 20 },
      { title: 'Thresholds reviewed at least annually.', sortOrder: 30 },
      { title: 'Exceptions to thresholds documented and approved.', sortOrder: 40 }
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
      { title: 'Annual Information Statement inputs complete.', sortOrder: 10 },
      { title: 'Financial statements reviewed and signed by the Board.', sortOrder: 20 },
      { title: 'ACNC submission lodged within statutory deadline.', sortOrder: 30 },
      { title: 'Submission confirmation and evidence pack retained.', sortOrder: 40 },
      { title: 'Responsible persons register updated for the period.', sortOrder: 50 }
    ]
  }
];

// ─── Combined + stats ────────────────────────────────────────────────────────

export const CHECKLIST_LIBRARY_V3 = [...GLOBAL_CHECKLISTS, ...ITEM_WISE_CHECKLISTS];

export const V3_LIBRARY_STATS = {
  version: '3.1',
  sourceFile: 'checklists_v3_clean.xlsx + checklists_v2.xlsx enrichment',
  total: 57,
  global: 10,
  itemWise: 47,
  categories: {
    Governance: 2,
    Compliance: 1,
    Audit: 1,
    Risk: 1,
    Finance: 10,
    'IT/Security': 1,
    Complaints: 1,
    HR: 1,
    BCP: 1,
    Operations: 8,
    'HR & Volunteers': 8,
    Marketing: 6,
    Donors: 4,
    'IT & Legal': 4
  }
};
