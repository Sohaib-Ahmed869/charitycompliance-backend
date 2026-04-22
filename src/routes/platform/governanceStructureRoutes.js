/**
 * Governance Structure Routes
 * 
 * API routes for governance structure
 */

import express from 'express';
import * as governanceStructureController from '../../controllers/governanceStructureController.js';
import { body } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireAdminOrOwner } from '../../middleware/rbac.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get governance structure
router.get(
  '/',
  validate,
  governanceStructureController.getGovernanceStructure
);

// Update governance structure
router.put(
  '/',
  requireAdminOrOwner,
  governanceStructureController.uploadFiles,
  [
    body('conflict_of_interest_clause')
      .trim()
      .notEmpty()
      .withMessage('Conflict of interest clause is required'),
    body('conflict_management_explanation')
      .trim()
      .notEmpty()
      .withMessage('Conflict management explanation is required'),
    body('works_with_vulnerable_people')
      .isIn(['yes', 'no'])
      .withMessage('Invalid value for works with vulnerable people'),
    body('safeguarding_details')
      .optional()
      .trim(),
    body('financial_governance_explanation')
      .optional()
      .trim(),
    body('third_party_controls')
      .trim()
      .notEmpty()
      .withMessage('Third-party controls is required'),
    body('accountability_explanation')
      .trim()
      .notEmpty()
      .withMessage('Accountability explanation is required'),
    body('member_concerns_process')
      .trim()
      .notEmpty()
      .withMessage('Member concerns process is required'),
    body('is_basic_religious_charity')
      .isIn(['yes', 'no', 'unsure'])
      .withMessage('Invalid value for basic religious charity')
  ],
  validate,
  governanceStructureController.updateGovernanceStructure
);

export default router;
