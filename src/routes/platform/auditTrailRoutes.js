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

// Download audit trail PDF for a single request
router.get('/download/:requestId', requirePermission('module:audit_trail:view'), auditTrailController.downloadAuditTrailPDF);

export default router;
