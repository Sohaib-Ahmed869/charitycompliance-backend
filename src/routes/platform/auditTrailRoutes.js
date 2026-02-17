/**
 * Audit Trail Routes
 */

import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import auditTrailController from '../../controllers/auditTrailController.js';

const router = express.Router();

router.use(authAndResolveTenant);

// Admin-only access (admins have *:* permission)
router.get('/list', requirePermission('module:audit_trail:view'), auditTrailController.getAuditTrail);

export default router;
