/**
 * Risk Routes
 *
 * API routes for risk management
 */

import express from 'express';
import * as riskController from '../../controllers/riskController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/counts', riskController.getRiskCounts);

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Risk title is required'),
    body('category').trim().notEmpty().withMessage('Category is required'),
    body('risk_owner_board_member_id').optional().isMongoId().withMessage('Invalid risk owner'),
    body('likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Likelihood must be 1-5'),
    body('consequence').optional().isInt({ min: 1, max: 5 }).withMessage('Consequence must be 1-5')
  ],
  validate,
  riskController.createRisk
);

router.get(
  '/',
  [
    query('status').optional().isIn(['draft', 'pending', 'under_treatment', 'approved', 'rejected', 'closed']),
    query('category').optional().trim(),
    query('search').optional().trim()
  ],
  validate,
  riskController.getRisks
);

router.get(
  '/:riskId',
  [param('riskId').isMongoId().withMessage('Invalid risk ID')],
  validate,
  riskController.getRiskById
);

router.put(
  '/:riskId',
  [
    param('riskId').isMongoId().withMessage('Invalid risk ID'),
    body('title').optional().trim().notEmpty(),
    body('category').optional().trim().notEmpty(),
    body('risk_owner_board_member_id').optional().isMongoId().withMessage('Invalid risk owner'),
    body('likelihood').optional().isInt({ min: 1, max: 5 }),
    body('consequence').optional().isInt({ min: 1, max: 5 })
  ],
  validate,
  riskController.updateRisk
);

router.delete(
  '/:riskId',
  [param('riskId').isMongoId().withMessage('Invalid risk ID')],
  validate,
  riskController.deleteRisk
);

export default router;
