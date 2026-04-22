/**
 * Organization Routes
 */

import express from 'express';
import { getOrganization, updateOrganization, updateSettings } from '../../controllers/organizationController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireAdminOrOwner } from '../../middleware/rbac.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/', getOrganization);
router.put('/', requireAdminOrOwner, updateOrganization);
router.put('/settings', requireAdminOrOwner, updateSettings);

export default router;
