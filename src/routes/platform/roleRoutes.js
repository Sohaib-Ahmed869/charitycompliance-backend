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

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/', getAllRoles);
router.get('/:roleId', getRoleById);
router.post('/', createRole);
router.put('/:roleId', updateRole);
router.delete('/:roleId', deleteRole);

router.post('/users/:userId/assign', assignRoleToUser);
router.delete('/users/:userId/roles/:roleId', removeRoleFromUser);
router.get('/users/:userId', getUserRoles);

export default router;
