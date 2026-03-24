/**
 * Audit Trail Routes
 */

import express from 'express';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import auditTrailController from '../../controllers/auditTrailController.js';
import { UserRepository } from '../../repositories/userRepository.js';

const router = express.Router();

router.use(authAndResolveTenant);

const allowOrgOwnerOrPermission = (permissions) => async (req, res, next) => {
  try {
    const userRepo = new UserRepository(req.tenantDb);
    const user = await userRepo.findById(req.user?.userId);
    if (user?.is_org_owner) return next();
    return requirePermission(permissions)(req, res, next);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to validate permissions'
    });
  }
};

// Org owner can always access. Others need audit/reporting view permission.
router.get('/list', allowOrgOwnerOrPermission(['module:audit_trail:view', 'module:reporting:view']), auditTrailController.getAuditTrail);

// Download audit trail PDF for a single request
router.get('/download/:requestId', requirePermission('module:audit_trail:view'), auditTrailController.downloadAuditTrailPDF);

export default router;
