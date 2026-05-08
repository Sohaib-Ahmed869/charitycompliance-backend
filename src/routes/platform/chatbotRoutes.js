import express from 'express';
import * as chatbotController from '../../controllers/chatbotController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';

const router = express.Router();

router.use(authAndResolveTenant);
router.use(requireFeatureFlag('ai.compliance_assistant'));
router.post('/message', chatbotController.chat);

export default router;
