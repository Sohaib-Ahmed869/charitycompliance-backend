import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as itAccessController from '../../controllers/itAccessController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/mfa-status', itAccessController.getMfaStatus);
router.post('/access-log', itAccessController.createAccessLogEntry);
router.get('/sweep-funds-access', itAccessController.listSweepFundsAccessAssignments);
router.post(
  '/sweep-funds-access',
  [
    body('portal').isIn(['paypal', 'stripe', 'gofundme', 'other']).withMessage('Invalid portal'),
    body('assignedUserId').isMongoId().withMessage('Assigned user is required'),
    body('permissions').optional().isArray().withMessage('Permissions must be an array')
  ],
  validate,
  itAccessController.createSweepFundsAccessAssignment
);
router.patch(
  '/sweep-funds-access/:assignmentId',
  [
    param('assignmentId').isMongoId().withMessage('Invalid assignment ID'),
    body('portal').optional().isIn(['paypal', 'stripe', 'gofundme', 'other']).withMessage('Invalid portal'),
    body('assignedUserId').optional().isMongoId().withMessage('Assigned user must be valid')
  ],
  validate,
  itAccessController.updateSweepFundsAccessAssignment
);
router.patch(
  '/subscriptions/:assetId/maintenance',
  [
    param('assetId').isMongoId().withMessage('Invalid subscription ID'),
    body('maintenanceChecklist').optional().isObject().withMessage('maintenanceChecklist must be an object')
  ],
  validate,
  itAccessController.updateSubscriptionMaintenanceChecklist
);
router.get('/subscriptions/maintenance-due', itAccessController.getSubscriptionsMaintenanceDue);

export default router;
