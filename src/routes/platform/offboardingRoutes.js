import express from 'express';
import { param } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireMfa } from '../../middleware/mfa.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validation.js';
import * as itAccessController from '../../controllers/itAccessController.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('people.hr'));

// Access Control & Offboarding is admin-only by default. Non-admins can only
// reach it if a position explicitly grants the `access_control` module in
// Roles & Permissions (admins pass via their `*:*` permission).
router.get('/', requirePermission('module:access_control:view'), itAccessController.listOffboardingRequests);

router.post(
  '/initiate/:userId',
  [param('userId').isMongoId().withMessage('Invalid user ID')],
  validate,
  requirePermission('module:access_control:edit'),
  requireMfa('offboarding_access'),
  itAccessController.initiateOffboarding
);

router.patch(
  '/:offboardingId/steps/:stepId',
  [
    param('offboardingId').isMongoId().withMessage('Invalid offboarding request ID'),
    param('stepId').isMongoId().withMessage('Invalid offboarding step ID')
  ],
  validate,
  requirePermission('module:access_control:edit'),
  itAccessController.updateOffboardingStep
);

export default router;
