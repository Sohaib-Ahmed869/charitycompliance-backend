/**
 * Authentication Routes
 */

import express from 'express';
import { register, login, refreshToken, verifyInvitationToken, acceptInvitation } from '../../controllers/authController.js';
import { registerValidator, loginValidator, refreshTokenValidator, acceptInvitationValidator } from '../../validators/authValidators.js';
import { validate } from '../../middleware/validation.js';

const router = express.Router();

router.post('/register', registerValidator, validate, register);
router.post('/login', loginValidator, validate, login);
router.post('/refresh', refreshTokenValidator, validate, refreshToken);

// Invitation routes (public - no auth required)
router.get('/invitation/:token', verifyInvitationToken);
router.post('/invitation/:token/accept', acceptInvitationValidator, validate, acceptInvitation);

export default router;
