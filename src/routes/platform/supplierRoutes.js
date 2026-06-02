/**
 * Supplier Routes — /api/v1/platform/suppliers
 *
 * All routes are tenant-scoped (authAndResolveTenant).
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requirePermission } from '../../middleware/rbac.js';
import * as supplierController from '../../controllers/supplierController.js';

const router = express.Router();
router.use(authAndResolveTenant);

// ─── List + counts + dropdown ──────────────────────────────────────────
router.get(
  '/',
  [
    query('vetting_status').optional().isIn(['draft', 'pending_review', 'approved', 'rejected']),
    query('category').optional().isIn(['goods', 'services', 'professional', 'utility', 'contractor', 'other']),
    query('is_active').optional().isBoolean().toBoolean(),
    query('search').optional().trim()
  ],
  validate,
  requirePermission('module:supplier_register:view'),
  supplierController.listSuppliers
);

router.get(
  '/counts',
  requirePermission('module:supplier_register:view'),
  supplierController.getSupplierCounts
);

// Dropdown is hit from the Expense form, so it's gated on
// expense permission, not supplier_register — users who can file an
// expense need to see the supplier picker even if they can't edit
// the register itself.
router.get(
  '/dropdown',
  requirePermission('module:expenses:view'),
  supplierController.getSupplierDropdown
);

// ─── Single supplier ───────────────────────────────────────────────────
router.get(
  '/:supplierId',
  [param('supplierId').isMongoId().withMessage('Invalid supplier ID')],
  validate,
  requirePermission('module:supplier_register:view'),
  supplierController.getSupplierById
);

router.get(
  '/:supplierId/expenses',
  [param('supplierId').isMongoId()],
  validate,
  requirePermission('module:supplier_register:view'),
  supplierController.getLinkedExpenses
);

// ─── Create / update / delete ──────────────────────────────────────────
router.post(
  '/',
  [
    body('legal_name').trim().notEmpty().withMessage('Legal name is required'),
    body('contact_email').optional({ checkFalsy: true }).isEmail().withMessage('Contact email must be valid'),
    body('category').optional().isIn(['goods', 'services', 'professional', 'utility', 'contractor', 'other']),
    body('payment_terms').optional().isIn(['net_7', 'net_14', 'net_30', 'net_60', 'prepaid', 'cod']),
    body('gst_registered').optional().isBoolean()
  ],
  validate,
  requirePermission('module:supplier_register:create'),
  supplierController.createSupplier
);

router.put(
  '/:supplierId',
  [
    param('supplierId').isMongoId(),
    body('legal_name').optional().trim().notEmpty(),
    body('contact_email').optional({ checkFalsy: true }).isEmail(),
    body('category').optional().isIn(['goods', 'services', 'professional', 'utility', 'contractor', 'other']),
    body('payment_terms').optional().isIn(['net_7', 'net_14', 'net_30', 'net_60', 'prepaid', 'cod']),
    body('gst_registered').optional().isBoolean(),
    body('is_active').optional().isBoolean()
  ],
  validate,
  requirePermission('module:supplier_register:edit'),
  supplierController.updateSupplier
);

router.delete(
  '/:supplierId',
  [param('supplierId').isMongoId()],
  validate,
  requirePermission('module:supplier_register:delete'),
  supplierController.deleteSupplier
);

// ─── Workflow actions ──────────────────────────────────────────────────
router.post(
  '/:supplierId/submit',
  [param('supplierId').isMongoId()],
  validate,
  requirePermission('module:supplier_register:edit'),
  supplierController.submitForVetting
);

router.post(
  '/:supplierId/revet',
  [param('supplierId').isMongoId()],
  validate,
  requirePermission('module:supplier_register:edit'),
  supplierController.revetSupplier
);

export default router;
