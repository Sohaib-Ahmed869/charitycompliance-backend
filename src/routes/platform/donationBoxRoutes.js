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
    body('box_still_at_location')
      .custom((v) => v === true || v === false || v === 'true' || v === 'false')
      .withMessage('box_still_at_location must be true or false'),
    body('collector_acknowledgement')
      .custom((v) => v === true || v === 'true')
      .withMessage('The collector must acknowledge this collection'),
    body('second_person_counted').optional().custom((v) => v === undefined || v === true || v === false || v === 'true' || v === 'false'),
    // Empty string must skip isMongoId (e.g. placeholder before user picks someone)
    body('second_counter_user_id').optional({ checkFalsy: true }).isMongoId().withMessage('second_counter_user_id must be a valid user id'),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.addDonationBoxEntry
);

router.post(
  '/:boxId/entries/:entryId/second-counter-ack',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    param('entryId').isMongoId().withMessage('Invalid entryId'),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.acknowledgeSecondCounter
);

router.post(
  '/:boxId/entries/:entryId/office-ack',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    param('entryId').isMongoId().withMessage('Invalid entryId'),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.acknowledgeOfficeReceipt
);

router.post(
  '/:boxId/entries/:entryId/assign-proof',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    param('entryId').isMongoId().withMessage('Invalid entryId'),
    body('assigned_to').optional().isMongoId().withMessage('assigned_to must be a user id'),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.assignDonationBoxEntryProof
);

router.post(
  '/:boxId/entries/:entryId/upload-proof',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    param('entryId').isMongoId().withMessage('Invalid entryId'),
    body('files').isArray().withMessage('files is required'),
    body('files.*.url').optional().isString(),
    body('files.*.key').optional().isString(),
    body('files.*.name').optional().isString(),
    body('files.*.file_name').optional().isString(),
    body('files.*.size').optional().isNumeric(),
    body('files.*.type').optional().isString(),
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.uploadDonationBoxEntryProof
);

export default router;

