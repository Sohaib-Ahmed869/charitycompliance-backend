/**
 * Current user profile routes
 * GET /me/profile, POST /me/profile/picture
 */

import express from 'express';
import * as profileController from '../../controllers/profileController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/profile', profileController.getProfile);
router.post('/profile/picture', uploadSingle, handleUploadError, profileController.uploadProfilePicture);

export default router;
