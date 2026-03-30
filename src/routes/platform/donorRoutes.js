/**
 * Donor Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { uploadDonorKycFiles, handleUploadError } from '../../middleware/upload.js';
import {
  createDonor,
  listDonors,
  getDonorById,
  updateDonor,
  uploadDonorKycDocuments
} from '../../controllers/donorController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Donor name is required'),
    body('donor_type').optional().isIn(['individual', 'corporate', 'foundation', 'government', 'other']),
    body('email').optional().isEmail().withMessage('Primary contact email must be valid')
  ],
  validate,
  createDonor
);

router.get(
  '/',
  [
    query('status').optional().isString(),
    query('search').optional().trim()
  ],
  validate,
  listDonors
);

router.get(
  '/:donorId',
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  getDonorById
);

router.put(
  '/:donorId',
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  updateDonor
);

// Upload donor KYC documents
router.post(
  '/:donorId/kyc/upload',
  [param('donorId').isMongoId().withMessage('Invalid donor ID')],
  validate,
  uploadDonorKycFiles,
  handleUploadError,
  uploadDonorKycDocuments
);

export default router;

