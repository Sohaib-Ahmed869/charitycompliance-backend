/**
 * Donation Box Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import * as donationBoxController from '../../controllers/donationBoxController.js';

const router = express.Router();

router.use(authAndResolveTenant);

// List donation boxes
router.get(
  '/',
  [
    query('status')
      .optional()
      .isIn(['active', 'inactive'])
      .withMessage('Invalid status'),
    query('search').optional().trim(),
  ],
  validate,
  requirePermission('module:donation_boxes:view'),
  donationBoxController.listDonationBoxes
);

// Create donation box
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Donation box name is required'),
    body('location')
      .notEmpty()
      .withMessage('location is required'),
    body('location.lat')
      .isFloat({ min: -90, max: 90 })
      .withMessage('location.lat must be a valid latitude'),
    body('location.lng')
      .isFloat({ min: -180, max: 180 })
      .withMessage('location.lng must be a valid longitude'),
    body('location.address').optional().trim(),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.createDonationBox
);

// Get donation box by ID (includes embedded entries)
router.get(
  '/:boxId',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
  ],
  validate,
  requirePermission('module:donation_boxes:view'),
  donationBoxController.getDonationBoxById
);

// Add entry against donation box
router.post(
  '/:boxId/entries',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    body('entry_date')
      .notEmpty()
      .withMessage('entry_date is required')
      .isISO8601()
      .withMessage('entry_date must be an ISO date'),
    body('tips_count')
      .optional({ nullable: true })
      .isInt({ min: 0 })
      .withMessage('tips_count must be a non-negative integer'),
    body('amount')
      .notEmpty()
      .withMessage('amount is required')
      .isFloat({ min: 0 })
      .withMessage('amount must be a non-negative number'),
    body('notes').optional().trim(),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.addDonationBoxEntry
);

export default router;

