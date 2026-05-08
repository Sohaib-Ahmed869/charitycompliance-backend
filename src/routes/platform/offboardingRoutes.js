import express from 'express';
import { param } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireMfa } from '../../middleware/mfa.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { validate } from '../../middleware/validation.js';
import * as itAccessController from '../../controllers/itAccessController.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('people.hr'));

router.get('/', itAccessController.listOffboardingRequests);

router.post(
  '/initiate/:userId',
  [param('userId').isMongoId().withMessage('Invalid user ID')],
  validate,
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
  itAccessController.updateOffboardingStep
);

export default router;
