/**
 * Monthly Compliance Checklist catalogue.
 *
 * Sourced from the "MATW International Ltd — Monthly Charity Compliance
 * Checklist" workbook: 8 module sheets, ~57 line items. Each item carries the
 * original Task ID, the task, a description, the regulatory reference, the
 * responsible person and the frequency.
 *
 * Items that can be objectively computed from data already in the platform are
 * marked `type: 'auto'` with an `autoRuleKey` resolved by
 * src/services/monthlyComplianceRules.js. Everything else is `type: 'manual'`
 * (a person ticks it for the month, optionally attaching evidence).
 *
 * Consumed by ChecklistService.ensureMonthlyComplianceTemplate() to build a
 * tenant `monthly_compliance` template (one template item per line below).
 */

export const MONTHLY_COMPLIANCE_CATALOG = [
  {
    module: 'Governance',
    items: [
      { code: 'GOV-01', title: 'Monthly Board Meeting (or delegation)', description: 'Confirm meeting scheduled; prepare and distribute agenda and papers at least 7 days prior; confirm quorum and record attendance.', reference: 'ACNC Governance Standards; Constitution; Corporations Act', responsible: 'Company Secretary / Chair / CEO', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.BOARD_MEETING_HELD' },
      { code: 'GOV-02', title: 'Minutes and Resolutions', description: 'Circulate draft minutes within 7 business days; record resolutions, action items, responsible persons and deadlines; file approved minutes in minute book.', reference: 'Corporations Act; ACNC record-keeping guidance', responsible: 'Company Secretary', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.MEETING_MINUTES_CIRCULATED' },
      { code: 'GOV-03', title: 'Responsible Persons Register', description: 'Review current Responsible People; confirm consents, contact details and roles; update ACNC Charity Portal within statutory timeframe.', reference: 'ACNC Notifying changes guidance', responsible: 'Company Secretary / Governance Officer', frequency: 'Monthly (check for changes)', type: 'auto', autoRuleKey: 'MONTHLY.RESPONSIBLE_PERSONS_CURRENT' },
      { code: 'GOV-04', title: 'Fit & Proper Person & Conflicts Checks', description: 'Ensure newly appointed Responsible People have completed consent to act, declarations of disqualifying histories, conflicts of interest and probity checks.', reference: 'Corporations Act; ACNC Governance Standards', responsible: 'Governance Officer / Chair', frequency: 'As required; verify monthly for new entries', type: 'auto', autoRuleKey: 'MONTHLY.RESPONSIBLE_PERSONS_CURRENT' },
      { code: 'GOV-05', title: 'Conflict of Interest Register Review', description: 'Review register; ensure declarations recorded in minutes; update mitigation plans for any declared conflicts.', reference: 'ACNC Governance Standards', responsible: 'Chair / Company Secretary', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.COI_REVIEWED' },
      { code: 'GOV-06', title: 'Board Skills Matrix & Succession', description: 'Update skills matrix; identify gaps; report on upcoming vacancies and succession plan actions.', reference: 'Good governance practice; ACNC guidance', responsible: 'Chair / Governance Committee', frequency: 'Quarterly (review monthly status)', type: 'manual' },
      { code: 'GOV-07', title: 'Delegations & Authorisations', description: 'Review delegated authorities and any approvals given under delegation during the month (finance, contracts, HR).', reference: 'Constitution; Delegations Policy', responsible: 'CEO / CFO / Company Secretary', frequency: 'Monthly', type: 'manual' },
      { code: 'GOV-08', title: 'Policy Review Cycle', description: 'Confirm policies reviewed per schedule; update any overdue policies.', reference: 'ACNC Governance Standards; internal policy schedule', responsible: 'Governance Officer / Head of HR', frequency: 'Monthly (by schedule)', type: 'auto', autoRuleKey: 'MONTHLY.POLICIES_CURRENT' },
      { code: 'GOV-09', title: 'Whistleblower & Complaints', description: 'Review whistleblower and complaints logs; ensure appropriate handling, protections and follow-ups; escalate to board if required.', reference: 'Whistleblower protections Act; ACNC complaints guidance', responsible: 'Company Secretary / Risk Officer', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.COMPLAINTS_HANDLED' },
      { code: 'GOV-10', title: 'Related Party Transactions', description: 'Identify and review any related-party transactions; ensure they were approved per policy and recorded.', reference: 'ACNC Guidance; Corporations Act', responsible: 'CFO / Governance Officer', frequency: 'Monthly', type: 'manual' },
      { code: 'GOV-11', title: 'Board Training & Induction', description: 'Confirm induction for new Responsible People and ongoing training completed.', reference: 'ACNC checklist for new responsible people', responsible: 'Governance Officer / Company Secretary', frequency: 'Monthly (training schedule)', type: 'auto', autoRuleKey: 'MONTHLY.TRAINING_CURRENT' },
      { code: 'GOV-12', title: 'Confidentiality & Privacy Compliance', description: 'Ensure board & staff have signed confidentiality agreements where required and privacy training up to date.', reference: 'Privacy Act; ACNC governance standards', responsible: 'Privacy Officer / Company Secretary', frequency: 'Monthly (by schedule)', type: 'manual' },
      { code: 'GOV-13', title: 'Insurance & D&O', description: 'Verify insurance policies active (D&O, public liability, volunteer cover); confirm upcoming renewals and claims status.', reference: 'Insurance policies; risk controls', responsible: 'Risk & CFO', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.INSURANCE_ACTIVE' },
      { code: 'GOV-14', title: 'Governance Reporting Pack', description: 'Prepare standard monthly governance pack for board including risk register, finance snapshot, major incidents and compliance exceptions.', reference: 'ACNC reporting expectations', responsible: 'CEO / Company Secretary', frequency: 'Monthly', type: 'manual' },
      { code: 'GOV-15', title: 'Regulatory Notifications & Compliance Calendar', description: 'Review upcoming lodgements (ACNC AIS, ASIC annual statement, BAS, grant reports) and ensure deadlines are on schedule.', reference: 'ACNC, ASIC, ATO guidance', responsible: 'Company Secretary / CFO', frequency: 'Monthly', type: 'manual' }
    ]
  },
  {
    module: 'Finance',
    items: [
      { code: 'FIN-01', title: 'Bank Reconciliations - All Accounts', description: 'Reconcile each bank account, merchant accounts and payment gateways to GL; review and clear reconciling items.', reference: 'ASIC guidance on financial reporting; internal control', responsible: 'Finance Manager / Accountant', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-02', title: 'Donation & Fund Reconciliation', description: 'Reconcile donations per campaign/platform to bank & donation ledger; flag unallocated or restricted gifts.', reference: 'ATO DGR receipts guidance; internal donations policy', responsible: 'Fundraising Manager / Accountant', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.DONATIONS_APPROVED' },
      { code: 'FIN-03', title: 'Management Accounts & Variance Analysis', description: 'Produce P&L, Balance Sheet, Cash Flow, and a variance analysis with explanations for material items.', reference: 'ACNC financial reporting guidance; accounting standards', responsible: 'CFO / Finance Manager', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-04', title: 'Payroll & STP Reporting', description: 'Confirm payroll processed, Single Touch Payroll lodged, superannuation paid, tax withheld accurate and payroll reconciliations complete.', reference: 'ATO STP guidance; Fair Work Act', responsible: 'Payroll Manager / HR', frequency: 'Monthly (per pay run)', type: 'manual' },
      { code: 'FIN-05', title: 'BAS / GST Review', description: 'Reconcile GST collected and paid; prepare BAS estimates/working papers and flag any adjustments.', reference: 'ATO BAS guidance', responsible: 'Accountant / CFO', frequency: 'Monthly (if lodged monthly/quarterly)', type: 'auto', autoRuleKey: 'MONTHLY.BAS_FISCAL_FILED' },
      { code: 'FIN-06', title: 'Accounts Payable & Authorisations', description: 'Confirm AP aged report reviewed, payments approved per delegations, check for duplicate payments and unusual vendors.', reference: 'Delegations policy, procurement policy', responsible: 'Accounts Payable Officer / Finance Manager', frequency: 'Weekly/Monthly', type: 'auto', autoRuleKey: 'MONTHLY.EXPENSES_APPROVED' },
      { code: 'FIN-07', title: 'Accounts Receivable & Grants Income', description: 'Review AR aging, follow-up debts; reconcile grant income to grant agreements and deferred income schedules.', reference: 'Grant agreements; ACNC reporting', responsible: 'Grants Officer / Accountant', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-08', title: 'Expense & Fraud Review', description: 'Run exception reports for unusual transactions, merchant codes, or high-value purchases; review expense reimbursements.', reference: 'Internal control, fraud policy', responsible: 'Finance Manager / Internal Audit', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-09', title: 'Fixed Assets & Depreciation', description: 'Update asset register for new purchases/disposals; reconcile ledger and calculate monthly depreciation.', reference: 'Accounting standards; asset policy', responsible: 'Finance Officer', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-10', title: 'Related Party & Trustee Transactions', description: 'Ensure related party transactions have approvals and are disclosed where required.', reference: 'ACNC/Corporations Act disclosure requirements', responsible: 'CFO / Company Secretary', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-11', title: 'Budget Monitoring & Cash Forecast', description: 'Update cashflow forecast, highlight upcoming funding shortfalls or surplus and recommend actions.', reference: 'Board-approved budget; ACNC guidance', responsible: 'CFO', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-12', title: 'Grant & Contract Compliance', description: 'Match expenditure to grant budget lines, check procurement compliance, prepare accruals and ensure milestone evidence is retained.', reference: 'Grant agreements; funder requirements', responsible: 'Grants Officer / Program Manager', frequency: 'Monthly', type: 'manual' },
      { code: 'FIN-13', title: 'Audit Preparedness & Working Papers', description: 'Maintain working papers for auditors, update audit issue log, and ensure timely responses to auditor requests.', reference: 'Audit standards; ASIC guidance', responsible: 'Finance Manager / Audit Committee', frequency: 'Monthly', type: 'manual' }
    ]
  },
  {
    module: 'Fundraising',
    items: [
      { code: 'FUND-01', title: 'Donation Receipts: Compliance Check', description: 'Issue receipts that meet ATO DGR requirements and keep copies.', reference: 'ATO Receipts guidance (DGR requirements)', responsible: 'Fundraising Manager / Finance', frequency: 'Within 7 days of gift', type: 'auto', autoRuleKey: 'MONTHLY.DONATIONS_APPROVED' },
      { code: 'FUND-02', title: 'Donation Allocation & Restrictions', description: 'Track restricted or purpose-specific donations; maintain a restricted funds ledger and evidence donor conditions are honoured.', reference: 'DGR rules; grant conditions', responsible: 'Fundraising Manager / Grants Officer', frequency: 'Monthly', type: 'manual' },
      { code: 'FUND-03', title: 'Appeals & Campaign Compliance', description: 'Review active appeals content for accuracy, ensure funds to be used as stated and monitor campaign performance.', reference: 'ACNC fundraising guidance; ATO DGR', responsible: 'Fundraising Team / Communications', frequency: 'Monthly', type: 'manual' },
      { code: 'FUND-04', title: 'Fundraising Licence & State Compliance', description: 'Check fundraising licences and permits in states/territories for events/appeals and renew as required; maintain register.', reference: 'State fundraising regulators; ACNC guidance', responsible: 'Compliance Officer / Fundraising Manager', frequency: 'Monthly (by schedule)', type: 'manual' },
      { code: 'FUND-05', title: 'Major Donor & Sponsorship Agreements', description: 'Ensure agreements are documented, record any naming rights or conditionality, and confirm sponsor benefits delivered.', reference: 'Contract law; donor agreements', responsible: 'Fundraising Manager / CEO', frequency: 'Monthly', type: 'manual' },
      { code: 'FUND-06', title: 'Crowdfunding & Third-Party Platforms', description: 'Reconcile funds raised via third-party platforms; confirm platform T&Cs and donor receipting are compliant.', reference: 'Platform terms; ATO DGR receipting', responsible: 'Fundraising / Finance', frequency: 'Monthly (campaign close)', type: 'manual' },
      { code: 'FUND-07', title: 'Gift Acceptance & Refusal Log', description: 'Operate per Gift Acceptance Policy; record any refused gifts and rationale.', reference: 'Gift Acceptance Policy; DGR rules', responsible: 'Fundraising Manager / CEO', frequency: 'Monthly', type: 'manual' }
    ]
  },
  {
    module: 'Programs',
    items: [
      { code: 'PROG-01', title: 'Program KPI & Output Review', description: 'Collect KPI data and compare against monthly targets; highlight shortfalls and corrective actions.', reference: 'Grant agreements; ACNC AIS programs section', responsible: 'Program Managers / M&E Officer', frequency: 'Monthly', type: 'manual' },
      { code: 'PROG-02', title: 'Beneficiary Records & Privacy', description: 'Ensure beneficiary records are current, consent recorded, and data stored per privacy policy; purge outdated data as required.', reference: 'Privacy Act; ACNC governance standards', responsible: 'Program Manager / Privacy Officer', frequency: 'Monthly', type: 'manual' },
      { code: 'PROG-03', title: 'Safeguarding & WWCC Checks', description: 'Verify staff and volunteer WWCC/work with vulnerable people checks up to date and completed; ensure safeguarding training completed.', reference: 'State child safety laws; ACNC guidance', responsible: 'Program Director / HR', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.WWCC_CURRENT' },
      { code: 'PROG-04', title: 'Client Feedback & Complaints', description: 'Review service user feedback, complaints and outcomes; implement corrective actions and improvements.', reference: 'ACNC governance standards; complaints policy', responsible: 'Quality Manager / Program Manager', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.COMPLAINTS_HANDLED' },
      { code: 'PROG-05', title: 'Program Budget & Expenditure Tracking', description: 'Confirm program expenditure aligns to budgets and grant conditions; code transactions correctly.', reference: 'Grant agreements; finance controls', responsible: 'Program Manager / Finance', frequency: 'Monthly', type: 'manual' },
      { code: 'PROG-06', title: 'Partnership & Sub-grant Oversight', description: 'Review partner performance, ensure MOUs and sub-grant documentation are up-to-date and funds used appropriately.', reference: 'ACNC External Conduct Standards; grant rules', responsible: 'Program Manager / Grants Officer', frequency: 'Monthly', type: 'manual' }
    ]
  },
  {
    module: 'HR and Volunteers',
    items: [
      { code: 'HR-01', title: 'Payroll & Contractor Classification Review', description: 'Spot-check contractor vs employee classification; ensure correct PAYG withholding and super for employees.', reference: 'Fair Work Act; ATO guidance', responsible: 'HR Manager / Payroll', frequency: 'Monthly', type: 'manual' },
      { code: 'HR-02', title: 'Mandatory Training & Licences', description: 'Track completion of mandatory training (WHS, safeguarding, privacy) and professional registrations.', reference: 'WHS legislation; ACNC governance standards', responsible: 'HR Manager / Training Coordinator', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.TRAINING_CURRENT' },
      { code: 'HR-03', title: 'Background Checks & WWCC', description: 'Verify criminal history and WWCC checks for staff & volunteers working with vulnerable groups are current.', reference: 'State screening laws; ACNC guidance', responsible: 'Volunteer Coordinator / HR', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.WWCC_CURRENT' },
      { code: 'HR-04', title: 'Volunteer Agreements & Insurance', description: 'Ensure volunteer agreements are signed, roles defined and covered by volunteer insurance.', reference: 'Insurance policy; volunteer policy', responsible: 'Volunteer Coordinator', frequency: 'Monthly', type: 'manual' },
      { code: 'HR-05', title: 'Performance & Wellbeing Check-ins', description: 'Managers complete short monthly wellbeing check-ins; track significant HR issues for escalation.', reference: 'Workplace health guidance', responsible: 'Line Managers / HR', frequency: 'Monthly', type: 'manual' }
    ]
  },
  {
    module: 'Risk and Compliance',
    items: [
      { code: 'RISK-01', title: 'Risk Register Review & Top Risks', description: 'Update risk register, reassess controls and residual ratings for top 10 risks; verify mitigation actions underway.', reference: 'ACNC Governance Standards; internal risk policy', responsible: 'Risk & Compliance Officer / Executive', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.RISK_REVIEWED' },
      { code: 'RISK-02', title: 'WHS Inspection & Hazard Log', description: 'Conduct site inspections, update hazard log and confirm corrective actions closed or scheduled.', reference: 'WHS legislation', responsible: 'WHS Officer / Facilities', frequency: 'Monthly', type: 'manual' },
      { code: 'RISK-03', title: 'Incident Management & Reporting', description: 'Review incidents (safety, financial, reputational); confirm investigations, corrective actions and reports to insurers/board as required.', reference: 'Insurance conditions; ACNC incident guidance', responsible: 'Risk Officer / Program Manager', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.INCIDENTS_LOGGED' },
      { code: 'RISK-04', title: 'Cybersecurity & Access Review', description: 'Review user accounts, privileged access, MFA compliance, backups tested and incident response readiness; patching status.', reference: 'OAIC guidance; Cybersecurity frameworks', responsible: 'IT Manager / Security Officer', frequency: 'Monthly', type: 'manual' },
      { code: 'RISK-05', title: 'Data Breach Readiness & NDB Assessment', description: 'Confirm data breach response plan in place and test; assess any suspected breaches against NDB criteria and notify OAIC/affected individuals if required.', reference: 'OAIC NDB scheme guidance', responsible: 'Privacy Officer / IT Manager', frequency: 'Monthly (or after any incident)', type: 'manual' },
      { code: 'RISK-06', title: 'Insurance Policy Review', description: 'Ensure policies in force, claims recorded and renewal premiums budgeted.', reference: 'Insurance contracts; risk policy', responsible: 'CFO / Risk Officer', frequency: 'Monthly', type: 'auto', autoRuleKey: 'MONTHLY.INSURANCE_ACTIVE' }
    ]
  },
  {
    module: 'Communications and Reporting',
    items: [
      { code: 'COMMS-01', title: 'Website & Charity Register Public Info', description: 'Ensure ACNC Charity Register public information and website pages reflect correct charitable purpose, fundraising, contact details and governance statements.', reference: 'ACNC public disclosure guidance', responsible: 'Communications Manager / Company Secretary', frequency: 'Monthly', type: 'manual' },
      { code: 'COMMS-02', title: 'Annual Information Statement Readiness', description: 'Maintain required records for AIS so that the AIS can be completed accurately when due.', reference: 'ACNC Annual Information Statement guidance', responsible: 'Company Secretary / Finance / Programs', frequency: 'Monthly', type: 'manual' },
      { code: 'COMMS-03', title: 'Donor & Stakeholder Communications', description: 'Prepare monthly donor update, publish impact stories only where consistent with consent and privacy; track opt-outs.', reference: 'Privacy Act; donor communication policy', responsible: 'Fundraising / Communications', frequency: 'Monthly', type: 'manual' },
      { code: 'COMMS-04', title: 'Media & Reputation Monitoring', description: 'Monitor media/social media for mentions or issues; escalate reputational issues to Exec & Board.', reference: 'ACNC charity standards (reputational risk)', responsible: 'Communications Manager', frequency: 'Daily/Monthly summary', type: 'manual' },
      { code: 'COMMS-05', title: 'External Reporting & Grant Requirements', description: 'Track upcoming grant reporting deadlines and ensure deliverables/metrics are collated monthly.', reference: 'Grant agreements; funder conditions', responsible: 'Grants Officer / Program Manager', frequency: 'Monthly', type: 'manual' }
    ]
  }
];

/** Flat ordered list of catalogue items with their module attached. */
export const MONTHLY_COMPLIANCE_ITEMS_FLAT = MONTHLY_COMPLIANCE_CATALOG.flatMap((m) =>
  m.items.map((it) => ({ ...it, module: m.module }))
);
