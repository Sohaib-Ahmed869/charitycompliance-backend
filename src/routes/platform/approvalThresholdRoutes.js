/**
 * Approval Threshold Routes
 */

import express from 'express';
import { body } from 'express-validator';
import { getThresholds, updateThresholds, getTierForAmount } from '../../controllers/approvalThresholdController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All threshold routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get current thresholds
router.get('/', getThresholds);

// Update thresholds
router.put('/',
  [
    body('currency').optional().isString().isLength({ min: 3, max: 3 }),
    body('tiers').isArray({ min: 4, max: 4 }),
    body('tiers.*.name').isIn(['petty_cash', 'low_cash', 'moderate_cash', 'high_cash']),
    body('tiers.*.min_amount').isFloat({ min: 0 }),
    body('tiers.*.max_amount').custom((value, { req, path }) => {
      // Last tier (high_cash) can have null max_amount
      const tierIndex = parseInt(path.match(/\[(\d+)\]/)[1]);
      const tierName = req.body.tiers[tierIndex].name;
      
      if (tierName === 'high_cash' && value === null) {
        return true;
      }
      
      if (typeof value !== 'number' || value < 0) {
        throw new Error('max_amount must be a positive number or null for high_cash');
      }
      
      return true;
    })
  ],
  updateThresholds
);

// Get tier for specific amount
router.get('/tier-for-amount', getTierForAmount);

export default router;
