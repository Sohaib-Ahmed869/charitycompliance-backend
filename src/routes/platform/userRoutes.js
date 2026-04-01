/**
 * User Routes
 * Team members listing
 */

import express from 'express';
import { body } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import * as userController from '../../controllers/userController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.post(
  '/auditors/invite',
  [
    body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('firstName').optional().isString().trim(),
    body('lastName').optional().isString().trim()
  ],
  validate,
  userController.inviteAuditor
);

router.get('/', userController.listTeamMembers);

export default router;
