/**
 * Organization Routes
 */

import express from 'express';
import { getOrganization, updateOrganization, updateSettings } from '../../controllers/organizationController.js';
import { authenticate } from '../../middleware/auth.js';
import { resolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

router.use(authenticate);
router.use(resolveTenant);

router.get('/', getOrganization);
router.put('/', updateOrganization);
router.put('/settings', updateSettings);

export default router;
