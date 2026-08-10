/**
 * Donation Box Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import * as donationBoxController from '../../controllers/donationBoxController.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('finance.cash_handling'));

// List donation boxes
router.get(
  '/',
  [
    query('status')
      .optional()
      // 'all' returns every box regardless of status (the repository already
      // treats it as "no status filter") — the mobile app lists everything and
      // filters client-side.
      .isIn(['active', 'inactive', 'all'])
      .withMessage('Invalid status'),
    query('search').optional().trim(),
  ],
  validate,
  requirePermission('module:donation_boxes:view'),
  donationBoxController.listDonationBoxes
);

// Create cash-handling collection point (donation box OR miscellaneous)
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('category')
      .optional()
      .isIn(['donation_box', 'miscellaneous'])
      .withMessage('category must be donation_box or miscellaneous'),
    body('source_type')
      .optional({ checkFalsy: true })
      .isIn(['fundraising_event', 'online_fundraise', 'in_person_appeal', 'workplace_giving', 'other'])
      .withMessage('source_type is not valid'),
    body('description').optional().isString().trim(),
    // location is required only for donation_box records; for miscellaneous it's optional
    body('location')
      .custom((value, { req }) => {
        const category = req.body?.category || 'donation_box';
        if (category === 'donation_box' && !value) {
          throw new Error('location is required for donation boxes');
        }
        return true;
      }),
    body('location.lat')
      .custom((value, { req }) => {
        const category = req.body?.category || 'donation_box';
        if (category === 'donation_box') {
          const n = typeof value === 'string' ? Number(value) : value;
          if (typeof n !== 'number' || Number.isNaN(n) || n < -90 || n > 90) {
            throw new Error('location.lat must be a valid latitude');
          }
        } else if (value !== undefined && value !== null && value !== '') {
          const n = typeof value === 'string' ? Number(value) : value;
          if (typeof n !== 'number' || Number.isNaN(n) || n < -90 || n > 90) {
            throw new Error('location.lat must be a valid latitude');
          }
        }
        return true;
      }),
    body('location.lng')
      .custom((value, { req }) => {
        const category = req.body?.category || 'donation_box';
        if (category === 'donation_box') {
          const n = typeof value === 'string' ? Number(value) : value;
          if (typeof n !== 'number' || Number.isNaN(n) || n < -180 || n > 180) {
            throw new Error('location.lng must be a valid longitude');
          }
        } else if (value !== undefined && value !== null && value !== '') {
          const n = typeof value === 'string' ? Number(value) : value;
          if (typeof n !== 'number' || Number.isNaN(n) || n < -180 || n > 180) {
            throw new Error('location.lng must be a valid longitude');
          }
        }
        return true;
      }),
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

// CASH-016/017 — Activate / deactivate a donation box. Single endpoint
// rather than two so the same client-side mutation handles both
// transitions just by switching `status` in the body.
router.patch(
  '/:boxId/status',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    body('status').isIn(['active', 'inactive']).withMessage('Status must be active or inactive')
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.setDonationBoxStatus
);

// CASH-010 — record the variance investigation on a single entry.
router.patch(
  '/:boxId/entries/:entryId/variance-investigation',
  [
    param('boxId').isMongoId().withMessage('Invalid donation box ID'),
    param('entryId').isMongoId().withMessage('Invalid entry ID'),
    body('status').optional().isIn(['none', 'open', 'investigating', 'resolved', 'unresolved']).withMessage('Invalid status'),
    body('notes').optional().isString().isLength({ max: 4000 }).withMessage('Notes must be 4000 chars or fewer')
  ],
  validate,
  requirePermission('module:donation_boxes:edit'),
  donationBoxController.setVarianceInvestigation
);

// Add entry against donation box / miscellaneous collection
// Category-specific requirements (e.g. box_still_at_location for donation boxes,
// gross_amount for miscellaneous) are enforced in the service layer once the
// parent record's category is known.
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
      .optional({ nullable: true, checkFalsy: true })
      .isFloat({ min: 0 })
      .withMessage('amount must be a non-negative number'),
    body('notes').optional().trim(),
    body('box_still_at_location')
      .optional({ nullable: true })
      .custom((v) => v === true || v === false || v === 'true' || v === 'false')
      .withMessage('box_still_at_location must be true or false'),
    body('collector_acknowledgement')
      .custom((v) => v === true || v === 'true')
      .withMessage('The collector must acknowledge this collection'),
    body('second_person_counted').optional().custom((v) => v === undefined || v === true || v === false || v === 'true' || v === 'false'),
    body('second_counter_user_id').optional({ checkFalsy: true }).isMongoId().withMessage('second_counter_user_id must be a valid user id'),
    // Miscellaneous-entry fields (all optional — enforced per-category in the service)
    body('gross_amount').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 }).withMessage('gross_amount must be a non-negative number'),
    body('expenses').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('expenses must be a non-negative number'),
    body('net_amount').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('net_amount must be a non-negative number'),
    body('participant_count').optional({ nullable: true }).isInt({ min: 0 }).withMessage('participant_count must be a non-negative integer'),
    body('payment_method').optional({ checkFalsy: true }).isIn(['cash', 'card', 'online', 'mixed', 'other']).withMessage('payment_method is not valid'),
    body('platform').optional().isString().trim(),
    body('period_start').optional({ checkFalsy: true }).isISO8601().withMessage('period_start must be an ISO date'),
    body('period_end').optional({ checkFalsy: true }).isISO8601().withMessage('period_end must be an ISO date'),
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

