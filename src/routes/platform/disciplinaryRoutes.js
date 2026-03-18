import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import {
  createDisciplinaryRecord,
  listDisciplinaryRecords,
  updateDisciplinaryRecord
} from '../../controllers/disciplinaryRecordController.js';

const router = express.Router();

router.use(authAndResolveTenant);

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

export default router;

