/**
 * COI Routes
 * 
 * API routes for COI workflows
 */

import express from 'express';
import coiController from '../../controllers/coiController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// PUBLIC ROUTE: External COI submission (no authentication required)
router.post(
  '/public/submit/:orgId',
  [
    param('orgId')
      .notEmpty()
      .withMessage('Organization ID is required'),
    body('external_submitter.name')
      .trim()
      .notEmpty()
      .withMessage('Submitter name is required'),
    body('external_submitter.email')
      .trim()
      .isEmail()
      .withMessage('Valid email is required'),
    body('external_submitter.phone')
      .optional()
      .trim(),
    body('coi_reason')
      .trim()
      .notEmpty()
      .withMessage('Conflict of interest description is required'),
    body('conflict_person_name')
      .trim()
      .notEmpty()
      .withMessage('Person in conflict name is required'),
    body('conflict_person_details')
      .trim()
      .notEmpty()
      .withMessage('Person in conflict details are required')
  ],
  validate,
  coiController.submitExternalCoi
);

// AUTHENTICATED ROUTES BELOW
router.use(authAndResolveTenant);

// Internal user declares a COI for themselves (in-app form).
router.post(
  '/declare',
  [
    body('coi_reason').trim().notEmpty().withMessage('Conflict of interest description is required'),
    body('conflict_person_name').trim().notEmpty().withMessage('Person in conflict name is required'),
    body('conflict_person_details').trim().notEmpty().withMessage('Person in conflict details are required'),
    body('submitter.name').optional().trim(),
    body('submitter.email').optional().trim().isEmail().withMessage('Valid email is required'),
    body('submitter.phone').optional().trim()
  ],
  validate,
  coiController.submitInternalCoi
);

router.get('/list', coiController.listCoiRequests);
router.get('/pending', coiController.getPendingCoiRequests);
router.get('/debug/all', coiController.debugGetAllCoi);

router.get(
  '/:coiRequestId',
  [
    param('coiRequestId')
      .isMongoId()
      .withMessage('Invalid COI request ID')
  ],
  validate,
  coiController.getCoiRequestById
);

router.post(
  '/:coiRequestId/approve',
  [
    param('coiRequestId')
      .isMongoId()
      .withMessage('Invalid COI request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('comments')
      .optional()
      .trim()
  ],
  validate,
  coiController.approveCoiRequest
);

router.post(
  '/:coiRequestId/reject',
  [
    param('coiRequestId')
      .isMongoId()
      .withMessage('Invalid COI request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('comments')
      .trim()
      .notEmpty()
      .withMessage('Rejection reason is required')
  ],
  validate,
  coiController.rejectCoiRequest
);

router.get(
  '/:coiRequestId/parent',
  [
    param('coiRequestId')
      .isMongoId()
      .withMessage('Invalid COI request ID')
  ],
  validate,
  coiController.getParentApprovalForCoi
);

// Assign external COI to a module (risk, finance, etc)
router.post(
  '/:coiRequestId/assign-to-module',
  [
    param('coiRequestId')
      .isMongoId()
      .withMessage('Invalid COI request ID'),
    body('module')
      .trim()
      .notEmpty()
      .withMessage('Module is required')
      .isIn(['risk', 'finance', 'expense', 'process'])
      .withMessage('Invalid module'),
    body('module_id')
      .trim()
      .notEmpty()
      .withMessage('Module ID is required')
      .isMongoId()
      .withMessage('Invalid module ID')
  ],
  validate,
  coiController.assignExternalCoiToModule
);

// Assign external COI to an approval workflow
router.post(
  '/:coiRequestId/assign-to-workflow',
  [
    param('coiRequestId')
      .isMongoId()
      .withMessage('Invalid COI request ID'),
    body('approval_request_id')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('step_index')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer')
  ],
  validate,
  coiController.assignCoiToWorkflow
);

export default router;
