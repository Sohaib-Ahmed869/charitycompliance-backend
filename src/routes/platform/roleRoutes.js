/**
 * Role Routes
 */

import express from 'express';
import {
  getAllRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  assignRoleToUser,
  removeRoleFromUser,
  getUserRoles
} from '../../controllers/roleController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireAdminOrOwner } from '../../middleware/rbac.js';

const router = express.Router();

router.use(authAndResolveTenant);
// SECURITY (API-002): role management is authorization-sensitive — reading OR
// altering roles, and assigning/removing them on users, is an admin/owner-only
// operation. These routes previously enforced only authentication, so any
// authenticated user could escalate privilege (e.g. grant themselves a role).
// Require admin/owner on EVERY route below.
router.use(requireAdminOrOwner);

router.get('/', getAllRoles);
router.get('/:roleId', getRoleById);
router.post('/', createRole);
router.put('/:roleId', updateRole);
router.delete('/:roleId', deleteRole);

router.post('/users/:userId/assign', assignRoleToUser);
router.delete('/users/:userId/roles/:roleId', removeRoleFromUser);
router.get('/users/:userId', getUserRoles);

export default router;
