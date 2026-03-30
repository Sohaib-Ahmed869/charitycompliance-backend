/**
 * Auditors get view access across product modules (read-only). Used at login and JWT auth.
 */
export const AUDITOR_VIEW_MODULE_IDS = [
  'dashboard',
  'approval_workflow',
  'audit_trail',
  'complaints',
  'charity_admin',
  'policies',
  'human_resources',
  'financial_mgmt',
  'risk_mgmt',
  'programs',
  'grants_donors',
  'reporting',
  'systems_legal',
  'donation_boxes',
  'social_media_campaigns',
  'coi',
  'asset_mgmt',
  'bcp',
  'legal_docs',
  'support_tickets'
];

export function buildAuditorPermissions() {
  return [
    'read:own',
    'auditor:read_only',
    ...AUDITOR_VIEW_MODULE_IDS.map((m) => `module:${m}:view`)
  ];
}
