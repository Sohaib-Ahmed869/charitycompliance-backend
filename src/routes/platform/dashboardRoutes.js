import express from 'express';
import * as dashboardController from '../../controllers/dashboardController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/stats', dashboardController.getDashboardStats);

export default router;
