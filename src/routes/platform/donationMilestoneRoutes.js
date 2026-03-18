import express from 'express';
import { body, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { createDonationMilestone, listDonationMilestones } from '../../controllers/donationMilestoneController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get(
  '/',
  [
    query('status').optional().isIn(['upcoming', 'completed', 'overdue']),
    query('funding_agreement_id').optional().isMongoId(),
    query('search').optional().trim()
  ],
  validate,
  listDonationMilestones
);

router.post(
  '/',
  [
    body('funding_agreement_id').isMongoId().withMessage('Funding agreement is required'),
    body('title').trim().notEmpty().withMessage('Milestone title is required'),
    body('due_date').isISO8601().withMessage('Due date is required'),
    body('amount').optional().isNumeric()
  ],
  validate,
  createDonationMilestone
);

export default router;

