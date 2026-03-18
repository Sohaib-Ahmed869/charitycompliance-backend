/**
 * Current user profile routes
 * GET /me/profile, POST /me/profile/picture
 */

import express from 'express';
import * as profileController from '../../controllers/profileController.js';
import * as totpController from '../../controllers/totpController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/profile', profileController.getProfile);
router.post('/profile/picture', uploadSingle, handleUploadError, profileController.uploadProfilePicture);

router.post('/mfa/totp/setup', totpController.setupTotp);
router.post('/mfa/totp/enable', totpController.enableTotp);
router.post('/mfa/totp/verify', totpController.verifyTotpForScope);

export default router;
