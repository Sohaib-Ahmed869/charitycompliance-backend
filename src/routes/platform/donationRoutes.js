import express from 'express';
import { body } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { createDonation, listDonations, getDonationById } from '../../controllers/donationController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/', listDonations);
router.get('/:donationId', getDonationById);

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Donation title is required'),
    body('amount').isNumeric().withMessage('Donation amount is required'),
    body('currency').optional().trim(),
    body('category').optional().trim()
  ],
  validate,
  createDonation
);

export default router;

