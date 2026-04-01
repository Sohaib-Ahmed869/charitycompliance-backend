/**
 * Organization Routes
 */

import express from 'express';
import { getOrganization, updateOrganization, updateSettings } from '../../controllers/organizationController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/', getOrganization);
router.put('/', updateOrganization);
router.put('/settings', updateSettings);

export default router;
