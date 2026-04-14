import express from 'express';
import { body, param } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import * as sweepFundsController from '../../controllers/sweepFundsController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/workflows', sweepFundsController.getSweepFundsWorkflows);
router.get('/history', sweepFundsController.getSweepFundsHistory);

router.post(
  '/initiate',
  [
    body('sourcePortal').isIn(['paypal', 'stripe', 'gofundme', 'other']).withMessage('Invalid source portal'),
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
    body('destinationAssetId').isMongoId().withMessage('Destination bank account is required'),
    body('receiptFiles').optional().isArray().withMessage('receiptFiles must be an array')
  ],
  validate,
  sweepFundsController.initiateSweepFundsTransfer
);

router.post(
  '/:transferId/approve',
  [
    param('transferId').isMongoId().withMessage('Invalid transfer ID'),
    body('comments').optional().isString()
  ],
  validate,
  sweepFundsController.approveSweepFundsTransfer
);

export default router;
