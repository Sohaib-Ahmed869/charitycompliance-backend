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

router.get('/', userController.listTeamMembers);

export default router;
