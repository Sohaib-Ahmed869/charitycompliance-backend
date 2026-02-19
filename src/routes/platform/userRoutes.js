/**
 * User Routes
 * Team members listing
 */

import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as userController from '../../controllers/userController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/', userController.listTeamMembers);

export default router;
