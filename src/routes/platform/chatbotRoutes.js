import express from 'express';
import * as chatbotController from '../../controllers/chatbotController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.post('/message', chatbotController.chat);

export default router;
