/**
 * Current user profile routes
 * GET /me/profile, POST /me/profile/picture
 */

import express from 'express';
import * as profileController from '../../controllers/profileController.js';
import * as totpController from '../../controllers/totpController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';
import { validate } from '../../middleware/validation.js';
import { body } from 'express-validator';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/profile', profileController.getProfile);
router.patch(
  '/profile',
  [
    body('first_name').optional().isString(),
    body('last_name').optional().isString(),
    body('firstName').optional().isString(),
    body('lastName').optional().isString(),
    body('email').optional().isEmail().withMessage('Valid email is required')
  ],
  validate,
  profileController.updateProfile
);
router.post('/profile/picture', uploadSingle, handleUploadError, profileController.uploadProfilePicture);

router.post('/mfa/totp/setup', totpController.setupTotp);
router.post('/mfa/totp/enable', totpController.enableTotp);
router.post('/mfa/totp/verify', totpController.verifyTotpForScope);

export default router;
