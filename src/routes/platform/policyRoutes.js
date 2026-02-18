/**
 * Policy Routes
 */

import express from 'express';
import * as policyController from '../../controllers/policyController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { uploadPolicySingle, handlePolicyUploadError } from '../../middleware/upload.js';

const router = express.Router();
router.use(authAndResolveTenant);

router.get(
  '/counts',
  policyController.getPolicyCounts
);

router.get(
  '/',
  [
    query('status').optional().isIn(['draft', 'active', 'under_review', 'expired', 'pending_review']).withMessage('Invalid status'),
    query('category').optional().trim(),
    query('search').optional().trim()
  ],
  validate,
  policyController.getPolicies
);

router.get(
  '/:policyId/logs',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.getPolicyDocumentLogs
);

router.get(
  '/:policyId/acknowledgements',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.getPolicyAcknowledgements
);

router.get(
  '/:policyId/approvals',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.getPolicyApprovals
);

router.get(
  '/:policyId/signoff',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.getPolicySignOffData
);

router.get(
  '/:policyId',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.getPolicyById
);

router.get(
  '/:policyId/me',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.getPolicyForCurrentUser
);

router.post(
  '/',
  requirePermission('policy:create'),
  uploadPolicySingle,
  handlePolicyUploadError,
  [
    body('title').trim().notEmpty().withMessage('Policy name is required'),
    body('category').trim().notEmpty().withMessage('Category is required'),
    body('policy_owner_id').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid policy owner'),
    body('department_id').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
    body().custom((value, { req }) => {
      const hasOwner = req.body.policy_owner_id && String(req.body.policy_owner_id).trim();
      const hasDept = req.body.department_id && String(req.body.department_id).trim();
      if (!hasOwner && !hasDept) {
        throw new Error('Policy owner or department is required');
      }
      return true;
    }),
    body('description').trim().notEmpty().withMessage('Policy description is required'),
    body('effective_date').optional().isISO8601().withMessage('Invalid effective date'),
    body('review_cycle').optional().isIn(['3 months', '6 months', '12 months', '24 months', 'other']).withMessage('Invalid review cycle'),
    body('review_date').optional().isISO8601().withMessage('Invalid review date'),
    body('status').optional().isIn(['draft', 'active', 'under_review', 'expired']).withMessage('Invalid status')
  ],
  validate,
  policyController.createPolicy
);

router.put(
  '/:policyId',
  requirePermission('policy:create'),
  [
    param('policyId').isMongoId().withMessage('Invalid policy ID'),
    body('title').optional().trim().notEmpty().withMessage('Policy name cannot be empty'),
    body('category').optional().trim().notEmpty().withMessage('Category cannot be empty'),
    body('policy_owner_id').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid policy owner'),
    body('department_id').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
    body('effective_date').optional().isISO8601().withMessage('Invalid effective date'),
    body('review_cycle').optional().isIn(['3 months', '6 months', '12 months', '24 months', 'other']),
    body('review_date').optional().isISO8601().withMessage('Invalid review date'),
    body('status').optional().isIn(['draft', 'active', 'under_review', 'expired'])
  ],
  validate,
  policyController.updatePolicy
);

router.put(
  '/:policyId/document',
  requirePermission('policy:create'),
  uploadPolicySingle,
  handlePolicyUploadError,
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.updatePolicyDocument
);

router.post(
  '/:policyId/acknowledge',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.acknowledgePolicy
);

// Review policy
router.post(
  '/:policyId/review',
  [
    param('policyId').isMongoId().withMessage('Invalid policy ID'),
    body('action').isIn(['approved_no_changes', 'updated', 'rejected']).withMessage('Invalid action'),
    body('comments').optional().trim(),
    body('next_review_date').optional().isISO8601().withMessage('Invalid next_review_date format').custom((value) => {
      if (value) {
        const selectedDate = new Date(value);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        selectedDate.setHours(0, 0, 0, 0);
        
        if (selectedDate < today) {
          throw new Error('Next review date cannot be in the past');
        }
      }
      return true;
    }),
    body('changes').optional().isObject().withMessage('Changes must be an object')
  ],
  validate,
  policyController.reviewPolicy
);

// Get policies pending review
router.get(
  '/pending-review',
  policyController.getPoliciesPendingReview
);

// Stream policy PDF (same-origin) for in-app viewer
router.get(
  '/:policyId/stream',
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.streamPolicyPdf
);

router.delete(
  '/:policyId',
  requirePermission('policy:create'),
  [param('policyId').isMongoId().withMessage('Invalid policy ID')],
  validate,
  policyController.deletePolicy
);

export default router;
