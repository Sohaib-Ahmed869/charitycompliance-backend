/**
 * Workflow Guard Service
 *
 * Single source of truth for "is an approval workflow configured for this module?"
 * Used by:
 *   - GET /platform/approvals/precheck  (FE pre-flight before opening a create form)
 *   - approvalWorkflowService.findMatchingRule (FE/server-side guard at submission)
 *
 * Categories (matrix-level workflow_category) and action types (rule-level action_type)
 * map 1:1 — see ACTION_TO_CATEGORY / CATEGORY_TO_ACTION below. Either side may be passed
 * in; this module normalizes them.
 */

import { ApprovalMatrixRepository } from '../repositories/approvalMatrixRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { AppError } from '../middleware/errorHandler.js';

// Keep aligned with WorkflowTab.jsx CATEGORY_TO_ACTION_MAP / ACTION_TO_CATEGORY_DEFAULT.
export const CATEGORY_TO_ACTION = {
  risk_management: 'risk',
  risk_treatment: 'risk_treatment',
  complaint_resolution: 'complaint',
  coi: 'coi',
  partner_vetting: 'partner_vetting',
  policy_approval: 'policy',
  hr_approval: 'hr',
  funding_agreement: 'funding_agreement',
  donation_workflow: 'donation',
  donation_agreement_workflow: 'donation_agreement',
  donation_milestone_workflow: 'donation_milestone',
  social_media_campaign_workflow: 'social_media_campaign',
  expense_approval: 'expense',
  project_approval: 'project',
  grant_approval: 'grant',
  donor_review: 'donor',
  emergency: 'emergency',
  sweep_funds_approval: 'sweep_funds',
  bas_lodgement_approval: 'bas_lodgement',
  financial_reporting_approval: 'financial_reporting',
  project_delivery_approval: 'project_delivery',
  project_delivery_changes_approval: 'project_delivery_changes',
  refunds_approval: 'refunds'
};

export const ACTION_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_TO_ACTION).map(([cat, act]) => [act, cat])
);

export const CATEGORY_DISPLAY_NAMES = {
  risk_management: 'Risk Management',
  risk_treatment: 'Risk Treatment',
  complaint_resolution: 'Complaint Resolution',
  coi: 'Conflict of Interest',
  partner_vetting: 'Partner Vetting',
  policy_approval: 'Policy Approval',
  hr_approval: 'HR Approval',
  funding_agreement: 'Funding Agreement',
  donation_workflow: 'Donations',
  donation_agreement_workflow: 'Donation Funding Agreements',
  donation_milestone_workflow: 'Donation Milestones',
  social_media_campaign_workflow: 'Social Media Campaigns',
  expense_approval: 'Expense Approval',
  project_approval: 'Project Approval',
  grant_approval: 'Grant Approval',
  donor_review: 'Donor Review',
  emergency: 'Emergency Response',
  sweep_funds_approval: 'Sweep Funds',
  bas_lodgement_approval: 'BAS Lodgment',
  financial_reporting_approval: 'Fiscal Reports',
  project_delivery_approval: 'Project Delivery',
  project_delivery_changes_approval: 'Project Delivery Changes',
  refunds_approval: 'Refunds'
};

const _normalize = (v) => String(v || '').trim().toLowerCase();

/** Resolve to { category, actionType } from either input; returns nulls if unrecognized. */
export const resolveCategoryAndAction = ({ category, actionType }) => {
  const c = _normalize(category);
  const a = _normalize(actionType);
  if (c && CATEGORY_TO_ACTION[c]) return { category: c, actionType: CATEGORY_TO_ACTION[c] };
  if (a && ACTION_TO_CATEGORY[a]) return { category: ACTION_TO_CATEGORY[a], actionType: a };
  // Tolerate legacy synonyms used elsewhere in the codebase.
  if (a === 'risk_management') return { category: 'risk_management', actionType: 'risk' };
  if (a === 'grant_approval') return { category: 'grant_approval', actionType: 'grant' };
  if (a === 'policy_approval') return { category: 'policy_approval', actionType: 'policy' };
  if (a === 'complaint_resolution') return { category: 'complaint_resolution', actionType: 'complaint' };
  return { category: null, actionType: null };
};

export const getDisplayName = (category) => CATEGORY_DISPLAY_NAMES[category] || category || 'this module';

export const getRedirectPath = (category) =>
  category
    ? `/role-permissions?tab=workflow&focusCategory=${encodeURIComponent(category)}`
    : '/role-permissions?tab=workflow';

/**
 * Lenient configured-check: any active+effective matrix that contains a rule with
 * the matching action_type (regardless of amount tier) satisfies the gate.
 * Tier mismatch is surfaced separately at submission time as NO_MATCHING_RULE.
 *
 * @returns {Promise<{ configured: boolean, category: string|null, actionType: string|null,
 *                     displayName: string, redirectPath: string }>}
 */
export const checkWorkflowConfigured = async ({ orgId, category, actionType, asOf }) => {
  const resolved = resolveCategoryAndAction({ category, actionType });
  const displayName = getDisplayName(resolved.category);
  const redirectPath = getRedirectPath(resolved.category);

  if (!resolved.category || !resolved.actionType) {
    return { configured: false, category: null, actionType: null, displayName, redirectPath };
  }

  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const matrixRepo = new ApprovalMatrixRepository(tenantDb);
  const matrices = await matrixRepo.findEffectiveByOrgId(org._id, asOf || new Date());

  const configured = (matrices || []).some((m) =>
    (m.rules || []).some((r) => r.is_active !== false && _normalize(r.action_type) === resolved.actionType)
  );

  return {
    configured,
    category: resolved.category,
    actionType: resolved.actionType,
    displayName,
    redirectPath
  };
};

/**
 * Throw a uniform WORKFLOW_NOT_CONFIGURED error if the gate fails.
 * Use this at the top of any controller/service create path to short-circuit early
 * with a structured error the FE can route on.
 */
export const assertWorkflowConfigured = async ({ orgId, category, actionType, asOf }) => {
  const result = await checkWorkflowConfigured({ orgId, category, actionType, asOf });
  if (result.configured) return result;

  throw new AppError(
    `No approval workflow is configured for ${result.displayName}. Please set one up before creating this request.`,
    400,
    'WORKFLOW_NOT_CONFIGURED',
    {
      category: result.category,
      actionType: result.actionType,
      displayName: result.displayName,
      redirectPath: result.redirectPath
    }
  );
};

export default {
  CATEGORY_TO_ACTION,
  ACTION_TO_CATEGORY,
  CATEGORY_DISPLAY_NAMES,
  resolveCategoryAndAction,
  getDisplayName,
  getRedirectPath,
  checkWorkflowConfigured,
  assertWorkflowConfigured
};
