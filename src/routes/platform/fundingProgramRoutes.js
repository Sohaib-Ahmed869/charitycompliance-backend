/**
 * Funding programs (charity programs under Funding)
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validation.js';
import {
  listFundingPrograms,
  getFundingProgramById,
  createFundingProgram,
  updateFundingProgram,
  deleteFundingProgram
} from '../../controllers/fundingProgramController.js';

const router = express.Router();

router.use(authAndResolveTenant);

const AU_LOCATION_VALUES = [
  'New South Wales',
  'Victoria',
  'Queensland',
  'South Australia',
  'Western Australia',
  'Tasmania',
  'Northern Territory',
  'Australian Capital Territory',
  'National / Australia-wide'
];

router.get(
  '/',
  [
    query('status').optional().isIn(['active', 'inactive']),
    query('search').optional().trim()
  ],
  validate,
  listFundingPrograms
);

router.get(
  '/location-options',
  (req, res) => {
    res.json({ success: true, data: AU_LOCATION_VALUES });
  }
);

router.get(
  '/:programId',
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  getFundingProgramById
);

router.post(
  '/',
  requirePermission('module:grants_donors:edit'),
  [
    body('name').trim().notEmpty().withMessage('Program name is required'),
    body('donor_id').isMongoId().withMessage('A donor must be selected'),
    body('description').optional().isString(),
    body('website_url').optional().isString(),
    body('beneficiaries').optional().isString(),
    body('locations').optional().isArray(),
    body('locations.*').optional().isIn(AU_LOCATION_VALUES),
    body('status').optional().isIn(['active', 'inactive'])
  ],
  validate,
  createFundingProgram
);

router.put(
  '/:programId',
  requirePermission('module:grants_donors:edit'),
  [
    param('programId').isMongoId().withMessage('Invalid program ID'),
    body('name').optional().trim().notEmpty(),
    body('donor_id').optional().isMongoId(),
    body('description').optional().isString(),
    body('website_url').optional().isString(),
    body('beneficiaries').optional().isString(),
    body('locations').optional().isArray(),
    body('locations.*').optional().isIn(AU_LOCATION_VALUES),
    body('status').optional().isIn(['active', 'inactive'])
  ],
  validate,
  updateFundingProgram
);

router.delete(
  '/:programId',
  requirePermission('module:grants_donors:edit'),
  [param('programId').isMongoId().withMessage('Invalid program ID')],
  validate,
  deleteFundingProgram
);

export default router;
