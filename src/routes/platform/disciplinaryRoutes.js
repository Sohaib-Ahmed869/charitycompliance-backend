import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { validate } from '../../middleware/validation.js';
import {
  createDisciplinaryRecord,
  listDisciplinaryRecords,
  updateDisciplinaryRecord,
  convertDisciplinaryRecordToComplaint
} from '../../controllers/disciplinaryRecordController.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('people.hr'));

router.get(
  '/',
  [
    query('status').optional().isIn(['open', 'investigation', 'resolved', 'declined']),
    query('search').optional().trim()
  ],
  validate,
  listDisciplinaryRecords
);

router.post(
  '/',
  [
    body('staff_member_id').notEmpty().isMongoId().withMessage('Valid staff_member_id is required'),
    body('issue_type').trim().notEmpty().withMessage('Issue type is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
  ],
  validate,
  createDisciplinaryRecord
);

router.put(
  '/:recordId',
  [
    param('recordId').notEmpty().isMongoId().withMessage('Valid record ID is required'),
    body('status').optional().isIn(['open', 'investigation', 'resolved', 'declined']),
  ],
  validate,
  updateDisciplinaryRecord
);

router.post(
  '/:recordId/convert-to-complaint',
  [
    param('recordId').notEmpty().isMongoId().withMessage('Valid record ID is required'),
    body('complainant_name').trim().notEmpty().withMessage('complainant_name is required'),
    body('complainant_email').isEmail().withMessage('Valid complainant_email is required'),
    body('complaint_title').trim().notEmpty().withMessage('complaint_title is required'),
    body('description').trim().notEmpty().withMessage('description is required'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']),
    body('submit_anonymously').optional().isBoolean(),
    body('attachments').optional().isArray(),
  ],
  validate,
  convertDisciplinaryRecordToComplaint
);

export default router;

